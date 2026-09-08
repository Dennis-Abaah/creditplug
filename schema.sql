-- ═══════════════════════════════════════════════
-- Credit Plug — Supabase Database Schema
-- Run this in the Supabase SQL Editor
-- ═══════════════════════════════════════════════


-- ── 1. Users Table ─────────────────────────────
-- Linked 1:1 to auth.users via `id`

CREATE TABLE public.users (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  phone_number  TEXT NOT NULL DEFAULT '',
  balance       NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index for fast lookups
CREATE INDEX idx_users_id ON public.users(id);

-- Auto-update `updated_at` on row changes
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_users_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_updated_at();


-- ── 2. Transactions Table ──────────────────────

CREATE TABLE public.transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount      NUMERIC(12, 2) NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('survey_credit', 'withdrawal')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  reference   TEXT,          -- external ref (e.g. TechLink orderId, CPX trans_id)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX idx_transactions_user_id   ON public.transactions(user_id);
CREATE INDEX idx_transactions_type      ON public.transactions(type);
CREATE INDEX idx_transactions_created   ON public.transactions(created_at DESC);


-- ── 3. Auto-create user profile on signup ──────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.users (id, phone_number)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'phone_number', '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();


-- ═══════════════════════════════════════════════
-- ROW LEVEL SECURITY (RLS)
-- ═══════════════════════════════════════════════

-- Enable RLS on both tables
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

-- ── Users: read own row ──
CREATE POLICY "Users can read own profile"
  ON public.users
  FOR SELECT
  USING (auth.uid() = id);

-- ── Users: update own row ──
CREATE POLICY "Users can update own profile"
  ON public.users
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── Users: insert own row (fallback for client-side) ──
CREATE POLICY "Users can insert own profile"
  ON public.users
  FOR INSERT
  WITH CHECK (auth.uid() = id);

-- ── Transactions: read own rows ──
CREATE POLICY "Users can read own transactions"
  ON public.transactions
  FOR SELECT
  USING (auth.uid() = user_id);

-- ── Transactions: insert own rows (for audit trail from edge functions) ──
-- Edge functions use the service_role key which bypasses RLS,
-- but this policy allows the anon key to read.
CREATE POLICY "Users can insert own transactions"
  ON public.transactions
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);


-- ═══════════════════════════════════════════════
-- GRANT ACCESS TO anon AND authenticated ROLES
-- ═══════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE ON public.users TO authenticated;
GRANT SELECT, INSERT ON public.transactions TO authenticated;
GRANT USAGE ON SCHEMA public TO anon, authenticated;


-- ═══════════════════════════════════════════════
-- ATOMIC BALANCE ADJUSTMENT (RPC)
-- Used by Edge Functions to safely credit/debit
-- ═══════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.adjust_balance(
  p_user_id UUID,
  p_amount  NUMERIC
)
RETURNS VOID AS $$
BEGIN
  UPDATE public.users
  SET balance = balance + p_amount
  WHERE id = p_user_id
    AND (balance + p_amount) >= 0;  -- Prevent negative balance

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Insufficient balance or user not found';
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
