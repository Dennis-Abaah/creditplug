// ═══════════════════════════════════════════════
// Credit Plug — TimeWall Postback Handler
// Supabase Edge Function (Deno/TypeScript)
//
// Receives S2S callbacks from TimeWall when a user
// completes a task or offer. Verifies SHA256 hash,
// credits balance atomically, and logs a `task_credit`.
//
// Deploy: supabase functions deploy timewall-postback
// ═══════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { crypto } from "https://deno.land/std@0.177.0/crypto/mod.ts";

// ── Environment Variables ──────────────────────
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TIMEWALL_SECRET_KEY   = Deno.env.get("TIMEWALL_SECRET_KEY") || "";

// ── SHA256 Helper ──────────────────────────────
// TimeWall hash formula: hash("sha256", userID . revenue . SecretKey)
// i.e. SHA256 of (userID + revenue + SecretKey) concatenated as strings
// IMPORTANT: Use revenue EXACTLY as received — do NOT round or reformat it
async function sha256(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
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
  if (req.method !== "GET" && req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url    = new URL(req.url);
  const params = url.searchParams;

  // ── TimeWall parameter names (matching their exact example format) ──
  // userid={userID}         — Supabase user UUID (our subid)
  // txid={transactionID}    — Unique transaction ID for idempotency
  // revenue={revenue}       — USD gross revenue earned
  // currency={currencyAmount} — Amount in local currency (GHS) to award/deduct
  // hash={hash}             — SHA256 security hash
  // type={type}             — Transaction type / status
  // withdrawid={withdrawid} — TimeWall withdrawal ID (logged for reference)
  // offername={offername}   — Offer name (logged for reference)
  const userid     = params.get("userid");
  const txid       = params.get("txid");
  const revenue    = params.get("revenue");
  const currency   = params.get("currency");
  const hash       = params.get("hash");
  const type       = params.get("type") || "1";
  const offername  = params.get("offername") || "";
  const withdrawid = params.get("withdrawid") || "";

  // Use currency (local GHS amount) first; fall back to revenue (USD)
  const amountStr = currency || revenue;

  // ── Validate required params ──
  if (!userid || !txid || !amountStr) {
    return jsonResponse({
      error: "Missing required parameters",
      required: ["userid", "txid", "currency (or revenue)"],
      received: Object.fromEntries(params.entries()),
    }, 400);
  }

  // ── SHA256 Hash Verification ──
  // Formula: SHA256(userID + revenue + SecretKey)  — from TimeWall docs
  // Use `revenue` string EXACTLY as received (do not round or reformat)
  if (TIMEWALL_SECRET_KEY && hash) {
    const revenueRaw = params.get("revenue") || "";
    const expectedHash = await sha256(`${userid}${revenueRaw}${TIMEWALL_SECRET_KEY}`);
    if (hash !== expectedHash) {
      console.error("TimeWall hash mismatch", { received: hash, expected: expectedHash });
      return jsonResponse({ error: "Invalid hash" }, 403);
    }
  }

  const amount = parseFloat(amountStr);
  if (isNaN(amount) || amount === 0) {
    return jsonResponse({ error: "Invalid amount value" }, 400);
  }

  // ── Initialize Supabase Admin Client ──
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── Idempotency: skip if already processed ──
  const { data: existing } = await supabaseAdmin
    .from("transactions")
    .select("id")
    .eq("reference", txid)
    .eq("type", "task_credit")
    .single();

  if (existing) {
    return jsonResponse({ ok: true, message: "Already processed" });
  }

  // ── Determine if this is a chargeback/reversal ──
  // TimeWall sends revenue as negative for chargebacks
  const isReversal = amount < 0
    || type === "chargeback"
    || type === "reversed"
    || type === "2"
    || type === "0";

  const finalAmount = isReversal ? -Math.abs(amount) : Math.abs(amount);
  const txStatus    = isReversal ? "failed" : "success";

  // ── Atomic Balance Adjustment via RPC ──
  const { error: rpcErr } = await supabaseAdmin.rpc("adjust_balance", {
    p_user_id: userid,
    p_amount: finalAmount,
  });

  if (rpcErr) {
    console.error("adjust_balance failed", rpcErr);
    return jsonResponse({ error: "Balance update failed" }, 500);
  }

  // ── Log Transaction ──
  const { error: txErr } = await supabaseAdmin.from("transactions").insert({
    user_id:   userid,
    amount:    Math.abs(amount),
    type:      "task_credit",
    status:    txStatus,
    reference: txid,
  });

  if (txErr) {
    console.error("Transaction log failed", txErr);
    return jsonResponse({ error: "Transaction log failed" }, 500);
  }

  const message = isReversal
    ? `Task credit reversed (offer: ${offername}, withdrawid: ${withdrawid})`
    : `Task credit applied (offer: ${offername})`;

  return jsonResponse({ ok: true, message });
});
