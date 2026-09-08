// ═══════════════════════════════════════════════
// Credit Plug — CPX Research Postback Handler
// Supabase Edge Function (Deno/TypeScript)
//
// Receives server-to-server callbacks from CPX Research
// when a user completes a survey. Verifies the MD5
// secure_hash, credits the user's balance, and logs
// a `survey_credit` transaction.
//
// Deploy: supabase functions deploy cpx-webhook
// ═══════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

// ── Environment Variables ──────────────────────
// Set these in Supabase Dashboard → Edge Functions → Secrets
const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CPX_SECURE_HASH_KEY  = Deno.env.get("CPX_SECURE_HASH_KEY")!; // Your CPX "Secure Hash Key"

// ── Helpers ────────────────────────────────────
async function md5(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("MD5", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Main Handler ───────────────────────────────
serve(async (req: Request) => {
  // Only accept GET (CPX typically sends GET postbacks)
  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const params = url.searchParams;

  // ── Extract CPX callback parameters ──
  const extUserId   = params.get("ext_user_id");     // Our Supabase user UUID
  const transId     = params.get("trans_id");         // CPX transaction ID
  const amountLocal = params.get("amount_local");     // Payout in local currency (GHS)
  const secureHash  = params.get("secure_hash");      // MD5 verification hash
  const status      = params.get("status");           // 1 = approved, 2 = reversed

  // ── Validate required params ──
  if (!extUserId || !transId || !amountLocal || !secureHash) {
    return jsonResponse({ error: "Missing required parameters" }, 400);
  }

  // ── Verify MD5 secure_hash ──
  // CPX hash formula: MD5(trans_id + "-" + ext_user_id + "-" + secure_hash_key)
  const expectedHash = await md5(`${transId}-${extUserId}-${CPX_SECURE_HASH_KEY}`);

  if (secureHash !== expectedHash) {
    console.error("Hash mismatch", { secureHash, expectedHash });
    return jsonResponse({ error: "Invalid secure_hash" }, 403);
  }

  const amount = parseFloat(amountLocal);
  if (isNaN(amount) || amount <= 0) {
    return jsonResponse({ error: "Invalid amount" }, 400);
  }

  // ── Initialize Supabase Admin Client ──
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Idempotency: check if this trans_id was already processed ──
  const { data: existing } = await supabaseAdmin
    .from("transactions")
    .select("id")
    .eq("reference", transId)
    .eq("type", "survey_credit")
    .single();

  if (existing) {
    return jsonResponse({ ok: true, message: "Already processed" });
  }

  // ── Handle reversals ──
  if (status === "2") {
    // Deduct the reversed amount
    const { error: deductErr } = await supabaseAdmin.rpc("adjust_balance", {
      p_user_id: extUserId,
      p_amount: -amount,
    });

    if (deductErr) {
      console.error("Balance reversal failed", deductErr);
      return jsonResponse({ error: "Reversal failed" }, 500);
    }

    await supabaseAdmin.from("transactions").insert({
      user_id: extUserId,
      amount: amount,
      type: "survey_credit",
      status: "failed",
      reference: transId,
    });

    return jsonResponse({ ok: true, message: "Reversed" });
  }

  // ── Credit user balance ──
  const { error: updateErr } = await supabaseAdmin
    .from("users")
    .update({ balance: supabaseAdmin.rpc ? undefined : undefined }) // handled below
    .eq("id", extUserId);

  // Use raw SQL via RPC for atomic balance update
  const { error: rpcErr } = await supabaseAdmin.rpc("adjust_balance", {
    p_user_id: extUserId,
    p_amount: amount,
  });

  if (rpcErr) {
    console.error("Balance credit failed", rpcErr);
    return jsonResponse({ error: "Credit failed" }, 500);
  }

  // ── Log transaction ──
  const { error: txErr } = await supabaseAdmin.from("transactions").insert({
    user_id: extUserId,
    amount: amount,
    type: "survey_credit",
    status: "success",
    reference: transId,
  });

  if (txErr) {
    console.error("Transaction log failed", txErr);
    return jsonResponse({ error: "Transaction log failed" }, 500);
  }

  return jsonResponse({ ok: true, message: "Credited" });
});
