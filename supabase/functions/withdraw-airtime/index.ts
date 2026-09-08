// ═══════════════════════════════════════════════
// Credit Plug — Airtime Withdrawal Edge Function
// Supabase Edge Function (Deno/TypeScript)
//
// Called by the frontend when a user requests an
// airtime withdrawal. Validates balance, deducts
// the amount, calls the TechLink GH Airtime API,
// and logs the transaction.
//
// Deploy: supabase functions deploy withdraw-airtime
// ═══════════════════════════════════════════════

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Environment Variables ──────────────────────
const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TECHLINK_API_KEY     = Deno.env.get("TECHLINK_API_KEY")!;

const MINIMUM_WITHDRAWAL = 3.0;
const TECHLINK_AIRTIME_URL = "https://api.techlinkgh.com/api/v1/airtime";

// ── Helpers ────────────────────────────────────
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    },
  });
}

function formatPhoneLocal(phone: string): string {
  let clean = phone.replace(/\D/g, "");
  if (clean.startsWith("233")) {
    clean = "0" + clean.substring(3);
  }
  if (!clean.startsWith("0")) {
    clean = "0" + clean;
  }
  return clean;
}

function detectNetwork(phone: string): "MTN" | "TELECEL" | "AT" {
  const local = formatPhoneLocal(phone);
  const prefix = local.substring(0, 3);
  if (["024", "054", "055", "059", "025", "053"].includes(prefix)) return "MTN";
  if (["020", "050"].includes(prefix)) return "TELECEL";
  if (["026", "056", "027", "057"].includes(prefix)) return "AT";
  return "MTN"; // Default fallback
}

// ── Main Handler ───────────────────────────────
serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
      },
    });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  // ── Authenticate the calling user ──
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const token = authHeader.replace("Bearer ", "");
  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);

  if (authErr || !user) {
    return jsonResponse({ error: "Invalid token" }, 401);
  }

  // ── Parse request body ──
  let body: { amount?: number; network?: "MTN" | "TELECEL" | "AT" };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const amount = body.amount;
  if (!amount || typeof amount !== "number" || amount < MINIMUM_WITHDRAWAL) {
    return jsonResponse(
      { error: `Minimum withdrawal is GHS ${MINIMUM_WITHDRAWAL.toFixed(2)}` },
      400
    );
  }

  // ── Fetch user profile ──
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from("users")
    .select("balance, phone_number")
    .eq("id", user.id)
    .single();

  if (profileErr || !profile) {
    return jsonResponse({ error: "User profile not found" }, 404);
  }

  const currentBalance = parseFloat(profile.balance);

  if (currentBalance < amount) {
    return jsonResponse({ error: "Insufficient balance" }, 400);
  }

  if (!profile.phone_number) {
    return jsonResponse({ error: "No phone number on file" }, 400);
  }

  // Determine network and phone format
  const formattedPhone = formatPhoneLocal(profile.phone_number);
  const selectedNetwork = body.network && ["MTN", "TELECEL", "AT"].includes(body.network)
    ? body.network
    : detectNetwork(profile.phone_number);

  // ── Deduct balance atomically ──
  const { error: deductErr } = await supabaseAdmin.rpc("adjust_balance", {
    p_user_id: user.id,
    p_amount: -amount,
  });

  if (deductErr) {
    console.error("Balance deduction failed", deductErr);
    return jsonResponse({ error: "Failed to deduct balance" }, 500);
  }

  // ── Log pending transaction ──
  const { data: txData, error: txErr } = await supabaseAdmin
    .from("transactions")
    .insert({
      user_id: user.id,
      amount: amount,
      type: "withdrawal",
      status: "pending",
    })
    .select("id")
    .single();

  if (txErr) {
    console.error("Transaction log failed", txErr);
    // Refund the balance
    await supabaseAdmin.rpc("adjust_balance", {
      p_user_id: user.id,
      p_amount: amount,
    });
    return jsonResponse({ error: "Transaction log failed" }, 500);
  }

  const txId = txData.id;

  // ── Call TechLink GH Airtime API ──
  try {
    const techlinkPayload = {
      network: selectedNetwork,
      phone: formattedPhone,
      amount: amount,
    };

    const techlinkRes = await fetch(TECHLINK_AIRTIME_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": TECHLINK_API_KEY,
      },
      body: JSON.stringify(techlinkPayload),
    });

    const techlinkData = await techlinkRes.json();

    if (techlinkRes.ok && techlinkData.success) {
      // ── Mark transaction as success ──
      await supabaseAdmin
        .from("transactions")
        .update({
          status: "success",
          reference: techlinkData.orderId || null,
        })
        .eq("id", txId);

      return jsonResponse({
        ok: true,
        message: techlinkData.message || "Airtime sent successfully",
        orderId: techlinkData.orderId,
      });
    } else {
      // ── TechLink returned an error — refund and mark failed ──
      console.error("TechLink error", techlinkData);

      await supabaseAdmin.rpc("adjust_balance", {
        p_user_id: user.id,
        p_amount: amount,
      });

      await supabaseAdmin
        .from("transactions")
        .update({ status: "failed" })
        .eq("id", txId);

      return jsonResponse(
        { error: techlinkData.message || "Airtime delivery failed" },
        502
      );
    }
  } catch (networkErr) {
    // ── Network error — refund and mark failed ──
    console.error("TechLink network error", networkErr);

    await supabaseAdmin.rpc("adjust_balance", {
      p_user_id: user.id,
      p_amount: amount,
    });

    await supabaseAdmin
      .from("transactions")
      .update({ status: "failed" })
      .eq("id", txId);

    return jsonResponse({ error: "Airtime service unavailable" }, 503);
  }
});

