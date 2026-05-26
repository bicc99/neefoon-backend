import { Router, type Request, type Response } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';

const router = Router();

const SUPPORTED_CURRENCIES = ['USD', 'THB'] as const;
type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

// Single source of truth for what the request body must look like. zod handles
// type checks, coercion (e.g. numeric strings become numbers), and produces
// human-readable errors for free. The currency-dependent minimum is enforced
// after parsing because it depends on two fields.
const checkoutSchema = z.object({
  amount: z.coerce.number().int().positive(),
  currency: z.enum(SUPPORTED_CURRENCIES),
});

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

// Stripe's minimum charge amounts for our two supported currencies.
// Sending less than this causes Stripe to reject the request.
const MIN_AMOUNT: Record<SupportedCurrency, number> = {
  USD: 1,   // $1.00
  THB: 20,  // ฿20
};

router.post('/create-checkout-session', async (req: Request, res: Response) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    res.status(400).json({
      error: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid input',
    });
    return;
  }
  const { amount, currency } = parsed.data;

  // Cross-field rule: the minimum depends on the currency, so it cannot live
  // inside the schema for a single field. Done after parsing so amount/currency
  // are already typed.
  if (amount < MIN_AMOUNT[currency]) {
    res.status(400).json({
      error: `amount must be at least ${MIN_AMOUNT[currency]} ${currency}`,
    });
    return;
  }

  try {
    // Stripe always wants amounts in the smallest currency unit.
    // Both USD (cents) and THB (satang) use a factor of 100.
    const unitAmount = amount * 100;

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
      success_url: `${FRONTEND_URL}/thank-you`,
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
