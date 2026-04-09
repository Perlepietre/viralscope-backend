const supabase = require('../supabase')
const Stripe = require('stripe')
require('dotenv').config()

module.exports = async (req, res) => {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY)
  const sig = req.headers['stripe-signature']
  let event

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    )
  } catch (err) {
    return res.status(400).json({ message: 'Webhook error: ' + err.message })
  }

  switch (event.type) {

    case 'customer.subscription.trial_will_end':
      // Trial sta per scadere — potresti inviare email promemoria
      console.log('Trial ending soon for:', event.data.object.customer)
      break

    case 'invoice.payment_succeeded':
      // Pagamento riuscito — attiva abbonamento
      const invoice = event.data.object
      await supabase
        .from('profiles')
        .update({ status: 'active' })
        .eq('stripe_customer_id', invoice.customer)
      console.log('Payment succeeded — user activated:', invoice.customer)
      break

    case 'invoice.payment_failed':
      // Pagamento fallito — notifica utente
      const failedInvoice = event.data.object
      await supabase
        .from('profiles')
        .update({ status: 'cancelled' })
        .eq('stripe_customer_id', failedInvoice.customer)
      console.log('Payment failed:', failedInvoice.customer)
      break

    case 'customer.subscription.deleted':
      // Abbonamento cancellato
      const sub = event.data.object
      await supabase
        .from('profiles')
        .update({ status: 'cancelled' })
        .eq('stripe_customer_id', sub.customer)
      console.log('Subscription cancelled:', sub.customer)
      break

    case 'customer.subscription.updated':
      // Piano aggiornato (upgrade/downgrade)
      console.log('Subscription updated:', event.data.object.customer)
      break
  }

  res.status(200).json({ received: true })
}