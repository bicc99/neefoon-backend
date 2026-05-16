import { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';

const router = Router();

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const FRONTEND_URL = process.env.FRONTEND_URL;

if (!STRIPE_SECRET_KEY) {
  console.error('FATAL: STRIPE_SECRET_KEY environment variable is not set');
  process.exit(1);
}

if (!FRONTEND_URL) {
  console.error('FATAL: FRONTEND_URL environment variable is not set');
  process.exit(1);
}

const stripe = new Stripe(STRIPE_SECRET_KEY);

type SupportedCurrency = 'USD' | 'THB';

// Stripe's minimum charge amounts for our two supported currencies.
// Sending less than this causes Stripe to reject the request.
const MIN_AMOUNT: Record<SupportedCurrency, number> = {
  USD: 1,   // $1.00
  THB: 20,  // ฿20
};

router.post('/create-checkout-session', async (req: Request, res: Response) => {
  const { amount, currency } = req.body as { amount: unknown; currency: unknown };

  if (currency !== 'USD' && currency !== 'THB') {
    res.status(400).json({ error: 'currency must be USD or THB' });
    return;
  }

  const numAmount = Number(amount);

  // Reject non-integers and amounts below Stripe's minimums.
  if (!Number.isFinite(numAmount) || !Number.isInteger(numAmount) || numAmount < MIN_AMOUNT[currency]) {
    res.status(400).json({ error: `amount must be a whole number of at least ${MIN_AMOUNT[currency]} ${currency}` });
    return;
  }

  try {
    // Stripe always wants amounts in the smallest currency unit.
    // Both USD (cents) and THB (satang) use a factor of 100.
    const unitAmount = numAmount * 100;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      // PromptPay is a THB-only payment method, so we include it only for THB sessions.
      // 'card' covers credit/debit cards, Apple Pay, and Google Pay on all currencies.
      payment_method_types: currency === 'THB' ? ['card', 'promptpay'] : ['card'],
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
                name: 'บริจาคเงินให้แอปพลิเคชั่นหนีฝุ่น (Neefoon App Donation)',
                description: "ร่วมสนับสนุนข้อมูลคุณภาพอากาศของ Neefoon ให้เข้าถึงได้ฟรีและอัปเดตอยู่เสมอ ทุกยอดบริจาคจะนำไปใช้เป็นค่าโฮสติ้งเซิร์ฟเวอร์และพัฒนาแอปพลิเคชันต่อไป - Help keep Neefoon's air quality data free and up-to-date. Every contribution goes toward server hosting, and app development.",
              },
            unit_amount: unitAmount,
          },
          quantity: 1,
        },
      ],
      success_url: `${FRONTEND_URL}/support?donated=true`,
      cancel_url: `${FRONTEND_URL}/support`,
    });

    if (!session.url) {
      // A standard payment-mode session always has a URL, but guard anyway.
      console.error('Stripe session created without a URL', { sessionId: session.id });
      res.status(500).json({ error: 'Failed to create checkout session' });
      return;
    }

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout session creation failed', err);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

export default router;
