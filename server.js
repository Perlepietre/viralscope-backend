const express = require('express')
const app = express()
app.use(express.json())

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  next()
})

app.post('/api/track-account', require('./api/track-account'))
app.post('/api/create-subscription', require('./api/create-subscription'))
app.post('/api/stripe-webhook', require('./api/stripe-webhook'))

app.get('/', (req, res) => res.json({ status: 'ViralScope backend running' }))

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`Server running on port ${PORT}`))
