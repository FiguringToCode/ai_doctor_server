const express = require('express')
const app = express()
const cors = require('cors')
const OpenAI = require('openai')
const jwt = require('jsonwebtoken')
const axios = require('axios')
const cookieParser = require('cookie-parser')


require('dotenv').config()

// CORS Configuration
app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Set-Cookie']
}))

app.use(express.json())
app.use(cookieParser())


// JWT Verification Middleware
const verifyJWT = (req, res, next) => {
    const token = req.cookies.jwt_token || req.headers.authorization?.split(' ')[1]

    if(!token){
        return res.status(401).json({error: "No Token Provided"})
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        req.user = decoded
        next()
    } catch (error) {
        return res.status(401).json({error: 'Invalid or expired token'})
    }
}


// Initiate Google OAuth
app.get('/auth/google', (req, res) => {
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/auth?client_id=${process.env.GOOGLE_CLIENT_ID}&redirect_uri=${process.env.BACKEND_URL || `http://localhost:${PORT}`}/auth/google/callback&response_type=code&scope=profile email`

    res.redirect(googleAuthUrl)
})


// Google OAUth Callback
app.get('/auth/google/callback', async (req, res) => {
    const { code } = req.query
    if(!code){
        return res.status(400).send("Authorization code not provided")
    }

    try {
        // Exchange code for Access Token
        const params = new URLSearchParams({
            client_id: process.env.GOOGLE_CLIENT_ID,
            client_secret: process.env.GOOGLE_CLIENT_SECRET,
            code: req.query.code,
            grant_type: "authorization_code",
            redirect_uri: `${process.env.BACKEND_URL || `http://localhost:${PORT}`}/auth/google/callback`
        })

        const tokenResponse = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" }  
        })

        const accessToken = tokenResponse.data.access_token

        // Fetch User info from google
        const userResponse = await axios.get('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${accessToken}` }
        })

        const { email, id: userId, name, picture } = userResponse.data

        console.log('✅ User authenticated:', { email, userId, name })

        // Issue JWT with user info
        const jwtToken = jwt.sign({
            email,
            userId,
            name,
            picture
        }, process.env.JWT_SECRET, {expiresIn: '1d'})

        // Store JWT in httpOnly cookie
        res.cookie("jwt_token", jwtToken, {
            httpOnly: true,
            secure: process.env.NODE_ENV === "capricon",
            sameSite: process.env.NODE_ENV === 'capricon' ? 'none' : 'lax',
            maxAge: 1 * 24 * 60 * 60 * 1000, // 1 Day
            path: '/'
        })

        // Redirect to frontend
        return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:5173'}/profile`)

    } catch (error) {
        console.error(error.response?.data || error.message)
        res.status(400).send("OAuth exchange failed")
    }
})


const API_KEY = process.env.OPENROUTER_API_KEY
if (!API_KEY) {
    console.error('Please set OPENROUTER API KEY in .env file')
    process.exit(1)
}


// OpenRouter via Open Ai SDK
const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: API_KEY
})

const MODEL = 'openrouter/owl-alpha'

const SYSTEM_PROMPT = `
You are an AI assistant acting as a helpful doctor consultant.
IMPORTANT: You are NOT a real doctor. Always advise consulting a licensed medical professional for diagnosis/treatment. Do not prescribe medications.

Respond with JSON only. No prose, markdown, or backticks.

Use exactly this schema and field names:
{
    "symptom_summary": "string - brief restatement of patient's symptoms",
    "possible_conditions": [
        {"name": "string", "likelihood": "low/medium/high", "key_symptoms": ["string"]},
        {"name": "string", "likelihood": "low/medium/high", "key_symptoms": ["string"]}
    ],
    "recommended_actions": [
        "string - immediate steps or home remedies",
        "string"
    ],
    "urgency_level": "low/medium/high/emergency",
    "urgent_symptoms": ["string - signs needing immediate medical attention", "string"],
    "follow_up_questions": ["string", "string"],
    "disclaimer": "string - reminder to see real doctor"
}

Rules: 
- Base on common medical knowledge only. No guarantees.
- Output valid JSON only, nothing else.
- Keep numbers unquoted.
- If unsure, use null or [] but keep the schema.
- Always include disclaimer.
`

// Health check for quick server validation
app.get('/health', (req, res) => {
    res.json({ ok: true })
})

// Protected Route - Get User Profile (requires JWT)
app.get('/user/profile', verifyJWT, async (req, res) => {
    try {
        res.json({
            user: {
                email: req.user.email,
                userId: req.user.userId,
                name: req.user.name,
                picture: req.user.picture
            }
        })
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch profile' })
    }
})

// Logout endpoint
app.post('/auth/logout', (req, res) => {
    res.clearCookie('jwt_token')
    res.json({ message: 'Logged out successfully' })
})

// GET /api/doctor-consult?symptoms=&age=&gender=
// Defaults: "headache", 30, "unknown"
app.get('/api/doctor-consult', verifyJWT, async (req, res) => {
    const symptoms = (req.query.symptoms || 'headache').toString()
    const age = Number(req.query.age || 30) || 30
    const gender = (req.query.gender || 'unknown').toString()

    const userPrompt = `Patient (age ${age}, ${gender}): ${symptoms}. Provide consultation as AI doctor.`

    try {
        const response = await client.chat.completions.create({
            model: MODEL,
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user', content: userPrompt }
            ]
        })

        console.log('Raw model response: ', JSON.stringify(response, null, 2))

        const content = response.choices?.[0]?.message?.content || ''

        try {
            const parsed = JSON.parse(content)
            return res.json(parsed)
        } catch (_) {
            return res.status(502).json({ error: 'Model did not return valid JSON', raw: content })
        }

    } catch (error) {
        const message = error?.response?.data || error?.message || 'Unknown error'
        return res.status(500).json({ error: 'Upstream error', detail: message })
    }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
    console.log(`AI Doctor Consultant server running on port ${PORT}`)
})