const express = require('express')
const app = express()
const cors = require('cors')
const OpenAI = require('openai')


require('dotenv').config()
app.use(cors())


const API_KEY = process.env.OPENROUTER_API_KEY
if(!API_KEY){
    console.error('Please set OPENROUTER API KEY in .env file')
    process.exit(1)
}


// OpenRouter via Open Ai SDK
const client = new OpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey: API_KEY
})

const MODEL = 'stepfun/step-3.5-flash:free'

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

// GET /api/doctor-consult?symptoms=&age=&gender=
// Defaults: "headache", 30, "unknown"
app.get('/api/doctor-consult', async (req, res) => {
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