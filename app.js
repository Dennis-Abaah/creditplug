/* ═══════════════════════════════════════════════
   Credit Plug — Application Logic
   Supabase Auth · CPX Research · Withdrawals
   ═══════════════════════════════════════════════ */

// ── Configuration ──────────────────────────────
const SUPABASE_URL  = 'https://ckegiefkzusqbpkyqkru.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNrZWdpZWZrenVzcWJwa3lxa3J1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NDMzOTUsImV4cCI6MjEwNDQxOTM5NX0.wOwZN1rZ61-gILpVgXEzEF37nkggI19wpsYeZdqPgyo';
const CPX_APP_ID    = '36008';

// ── Supabase Client ────────────────────────────
let supabaseClient;
try {
  if (window.supabase && typeof window.supabase.createClient === 'function') {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
    console.log('✅ Supabase client initialized');
  } else {
    console.error('❌ window.supabase is not available');
  }
} catch (err) {
  console.error('❌ Failed to initialize Supabase client:', err);
}


/* ═══════════════════════════════════════════════
   WAIT FOR DOM BEFORE ATTACHING ANYTHING
   ═══════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {

  // ── DOM References ─────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const authContainer = $('#auth-container');
  const appContainer  = $('#app-container');
  const loginForm     = $('#login-form');
  const signupForm    = $('#signup-form');
  const navItems      = $$('.nav-item');
  const tabContents   = $$('.tab-content');


  /* ═══════════════════════════════════════════════
     HELPERS
     ═══════════════════════════════════════════════ */

  function formatGHS(amount) {
    const num = parseFloat(amount) || 0;
    return `GHS ${num.toFixed(2)}`;
  }

  function formatDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GH', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  }

  function getGreeting() {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  }

  function showToast(message) {
    const toast = $('#toast');
    if (!toast) return;
    toast.textContent = message;
    toast.classList.remove('hidden');
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 200);
    }, 2800);
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    if (loading) {
      btn.dataset.originalText = btn.textContent;
      btn.innerHTML = '<span class="spinner"></span>';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.originalText || 'Submit';
      btn.disabled = false;
    }
  }


  /* ═══════════════════════════════════════════════
     AUTH STATE MANAGEMENT
     ═══════════════════════════════════════════════ */

  let currentUser = null;
  let userProfile = null;

  async function init() {
    if (!supabaseClient) {
      console.error('Supabase not initialized');
      showAuth();
      return;
    }

    try {
      const { data: { session }, error } = await supabaseClient.auth.getSession();
      console.log('Session check:', session ? 'Active session found' : 'No session', error || '');

      if (session) {
        currentUser = session.user;
        await enterApp();
      } else {
        showAuth();
      }
    } catch (err) {
      console.error('Init error:', err);
      showAuth();
    }

    // Listen for future auth changes
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      console.log('Auth state changed:', event);
      if (event === 'SIGNED_IN' && session) {
        currentUser = session.user;
        await enterApp();
      } else if (event === 'SIGNED_OUT') {
        currentUser = null;
        userProfile = null;
        showAuth();
      }
    });
  }

  function showAuth() {
    if (authContainer) authContainer.classList.remove('hidden');
    if (appContainer) appContainer.classList.add('hidden');
  }

  async function enterApp() {
    if (authContainer) authContainer.classList.add('hidden');
    if (appContainer) appContainer.classList.remove('hidden');
    const greetEl = $('#greeting-text');
    if (greetEl) greetEl.textContent = getGreeting();

    await loadUserProfile();
    await loadBalance();
    loadCPXSurveys();
    switchTab('home');
  }


  /* ═══════════════════════════════════════════════
     SIGN UP
     ═══════════════════════════════════════════════ */

  if (signupForm) {
    signupForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      console.log('Signup form submitted');

      const email    = $('#signup-email').value.trim();
      const phone    = $('#signup-phone').value.trim();
      const password = $('#signup-password').value;
      const errEl    = $('#signup-error');
      const succEl   = $('#signup-success');
      const btn      = $('#signup-btn');

      errEl.textContent = '';
      succEl.classList.add('hidden');

      if (!email) {
        errEl.textContent = 'Email is required.';
        return;
      }

      if (!phone) {
        errEl.textContent = 'Phone number is required.';
        return;
      }

      if (!password || password.length < 8) {
        errEl.textContent = 'Password must be at least 8 characters.';
        return;
      }

      setLoading(btn, true);

      try {
        console.log('Calling supabase.auth.signUp...');
        const { data, error } = await supabaseClient.auth.signUp({
          email,
          password,
          options: {
            data: { phone_number: phone }
          }
        });

        setLoading(btn, false);

        if (error) {
          console.error('Signup error:', error);
          errEl.textContent = error.message;
          return;
        }

        console.log('Signup response:', data);

        // If email confirmation is enabled, show a success message
        if (data.user && !data.session) {
          succEl.textContent = 'Account created! Check your email to confirm, then sign in.';
          succEl.classList.remove('hidden');
          showToast('Account created successfully!');
          return;
        }

        // If auto-confirmed, auth listener will fire and enter the app
        showToast('Welcome to Credit Plug!');
      } catch (err) {
        console.error('Signup exception:', err);
        setLoading(btn, false);
        errEl.textContent = 'Network error. Please check your connection.';
      }
    });
  } else {
    console.error('❌ Signup form not found in DOM');
  }


  /* ═══════════════════════════════════════════════
     LOGIN
     ═══════════════════════════════════════════════ */

  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      console.log('Login form submitted');

      const email    = $('#login-email').value.trim();
      const password = $('#login-password').value;
      const errEl    = $('#login-error');
      const btn      = $('#login-btn');

      errEl.textContent = '';
      setLoading(btn, true);

      try {
        console.log('Calling supabase.auth.signInWithPassword...');
        const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

        setLoading(btn, false);

        if (error) {
          console.error('Login error:', error);
          errEl.textContent = error.message;
          return;
        }

        console.log('Login success:', data.user?.email);
        showToast('Signed in successfully!');
      } catch (err) {
        console.error('Login exception:', err);
        setLoading(btn, false);
        errEl.textContent = 'Network error. Please check your connection.';
      }
    });
  } else {
    console.error('❌ Login form not found in DOM');
  }


  /* ═══════════════════════════════════════════════
     AUTH FORM TOGGLING
     ═══════════════════════════════════════════════ */

  const showSignupLink = $('#show-signup');
  const showLoginLink  = $('#show-login');

  if (showSignupLink) {
    showSignupLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (loginForm) loginForm.classList.add('hidden');
      if (signupForm) signupForm.classList.remove('hidden');
      $('#login-error').textContent = '';
    });
  }

  if (showLoginLink) {
    showLoginLink.addEventListener('click', (e) => {
      e.preventDefault();
      if (signupForm) signupForm.classList.add('hidden');
      if (loginForm) loginForm.classList.remove('hidden');
      $('#signup-error').textContent = '';
      const succEl = $('#signup-success');
      if (succEl) succEl.classList.add('hidden');
    });
  }


  /* ═══════════════════════════════════════════════
     BOTTOM NAV — TAB SWITCHING
     ═══════════════════════════════════════════════ */

  function switchTab(tab) {
    navItems.forEach(n => n.classList.toggle('active', n.dataset.tab === tab));
    tabContents.forEach(t => {
      const isActive = t.id === `tab-${tab}`;
      t.classList.toggle('active', isActive);
    });

    // Refresh data when switching tabs
    if (tab === 'withdraw') {
      loadBalance();
      loadTransactions();
    } else if (tab === 'profile') {
      loadProfileStats();
    }
  }

  navItems.forEach(item => {
    item.addEventListener('click', () => switchTab(item.dataset.tab));
  });


  /* ═══════════════════════════════════════════════
     USER PROFILE
     ═══════════════════════════════════════════════ */

  async function loadUserProfile() {
    if (!currentUser) return;

    try {
      const { data, error } = await supabaseClient
        .from('users')
        .select('*')
        .eq('id', currentUser.id)
        .single();

      if (error && error.code === 'PGRST116') {
        // Profile doesn't exist yet — create it (triggered by signup)
        const phone = currentUser.user_metadata?.phone_number || '';
        const { data: newProfile } = await supabaseClient
          .from('users')
          .insert({ id: currentUser.id, phone_number: phone, balance: 0 })
          .select()
          .single();
        userProfile = newProfile;
      } else if (data) {
        userProfile = data;
      }
    } catch (err) {
      console.error('Load profile error:', err);
    }

    // Populate profile UI
    if (currentUser) {
      const emailEl = $('#profile-email');
      const phoneEl = $('#profile-phone');
      const avatarEl = $('#profile-avatar');
      if (emailEl) emailEl.textContent = currentUser.email || '—';
      if (phoneEl) phoneEl.textContent = userProfile?.phone_number || '—';
      if (avatarEl) avatarEl.textContent = (currentUser.email || 'U')[0].toUpperCase();
    }
  }

  async function loadBalance() {
    if (!currentUser) return;

    try {
      const { data } = await supabaseClient
        .from('users')
        .select('balance')
        .eq('id', currentUser.id)
        .single();

      const bal = data?.balance || 0;
      const homeBalEl = $('#home-balance');
      const wdBalEl = $('#withdraw-balance');
      const statBalEl = $('#stat-balance');
      if (homeBalEl) homeBalEl.textContent = formatGHS(bal);
      if (wdBalEl) wdBalEl.textContent = formatGHS(bal);
      if (statBalEl) statBalEl.textContent = formatGHS(bal);
    } catch (err) {
      console.error('Load balance error:', err);
    }
  }


  /* ═══════════════════════════════════════════════
     CPX RESEARCH SURVEYS
     ═══════════════════════════════════════════════ */

  function loadCPXSurveys() {
    if (!currentUser) return;

    const container = $('#cpx-container');
    const placeholder = $('#cpx-placeholder');
    if (!container) return;

    // Prevent duplicate iframes
    if (container.querySelector('iframe')) return;

    // Build CPX Research embed URL with user's UUID
    const cpxUrl = `https://offers.cpx-research.com/index.php?app_id=${CPX_APP_ID}&ext_user_id=${currentUser.id}&username=${encodeURIComponent(currentUser.email || '')}`;

    // Create iframe
    const iframe = document.createElement('iframe');
    iframe.src = cpxUrl;
    iframe.title = 'CPX Research Surveys';
    iframe.setAttribute('loading', 'lazy');
    iframe.setAttribute('allow', 'clipboard-write');

    iframe.addEventListener('load', () => {
      if (placeholder) placeholder.classList.add('hidden');
    });

    container.appendChild(iframe);
  }


  /* ═══════════════════════════════════════════════
     TRANSACTIONS
     ═══════════════════════════════════════════════ */

  async function loadTransactions() {
    if (!currentUser) return;

    try {
      const { data, error } = await supabaseClient
        .from('transactions')
        .select('*')
        .eq('user_id', currentUser.id)
        .order('created_at', { ascending: false })
        .limit(50);

      const listEl = $('#tx-list');
      const emptyEl = $('#tx-empty');
      if (!listEl) return;

      // Clear previous items (keep empty state)
      listEl.querySelectorAll('.tx-item').forEach(el => el.remove());

      if (!data || data.length === 0) {
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      if (emptyEl) emptyEl.classList.add('hidden');

      data.forEach(tx => {
        const item = document.createElement('div');
        item.className = 'tx-item';

        const typeLabel = tx.type === 'survey_credit' ? 'Survey Credit' : 'Withdrawal';
        const amountClass = tx.type === 'survey_credit' ? 'credit' : 'debit';
        const prefix = tx.type === 'survey_credit' ? '+' : '−';

        item.innerHTML = `
          <div class="tx-left">
            <span class="tx-type">${typeLabel}</span>
            <span class="tx-date">${formatDate(tx.created_at)}</span>
          </div>
          <div class="tx-right">
            <span class="tx-amount ${amountClass}">${prefix} ${formatGHS(tx.amount)}</span>
            <span class="tx-status ${tx.status}">${tx.status}</span>
          </div>
        `;

        listEl.appendChild(item);
      });
    } catch (err) {
      console.error('Load transactions error:', err);
    }
  }


  /* ═══════════════════════════════════════════════
     WITHDRAW
     ═══════════════════════════════════════════════ */

  const withdrawForm = $('#withdraw-form');
  if (withdrawForm) {
    withdrawForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const amountInput = $('#withdraw-amount');
      const amount = parseFloat(amountInput.value);
      const networkSelect = $('#withdraw-network');
      const network = networkSelect ? networkSelect.value : 'AUTO';
      const errEl  = $('#withdraw-error');
      const succEl = $('#withdraw-success');
      const btn    = $('#withdraw-btn');

      errEl.textContent = '';
      succEl.classList.add('hidden');

      if (isNaN(amount) || amount < 3) {
        errEl.textContent = 'Minimum withdrawal is GHS 3.00.';
        return;
      }

      setLoading(btn, true);

      try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (!session) {
          errEl.textContent = 'Session expired. Please log in again.';
          setLoading(btn, false);
          return;
        }

        const payload = { amount };
        if (network && network !== 'AUTO') {
          payload.network = network;
        }

        const res = await fetch(`${SUPABASE_URL}/functions/v1/withdraw-airtime`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`
          },
          body: JSON.stringify(payload)
        });

        const result = await res.json();

        if (!res.ok) {
          errEl.textContent = result.error || 'Withdrawal failed. Try again.';
          setLoading(btn, false);
          return;
        }

        succEl.textContent = `Withdrawal of ${formatGHS(amount)} submitted successfully.`;
        succEl.classList.remove('hidden');
        amountInput.value = '';

        showToast('Airtime withdrawal submitted!');
        await loadBalance();
        await loadTransactions();
      } catch (err) {
        console.error('Withdraw error:', err);
        errEl.textContent = 'Network error. Please try again.';
      }

      setLoading(btn, false);
    });
  }


  /* ═══════════════════════════════════════════════
     PROFILE STATS
     ═══════════════════════════════════════════════ */

  async function loadProfileStats() {
    if (!currentUser) return;

    await loadBalance();

    try {
      // Total earned (sum of survey_credit transactions with status success)
      const { data: earned } = await supabaseClient
        .from('transactions')
        .select('amount')
        .eq('user_id', currentUser.id)
        .eq('type', 'survey_credit')
        .eq('status', 'success');

      const totalEarned = (earned || []).reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
      const earnedEl = $('#stat-earned');
      const surveysEl = $('#stat-surveys');
      if (earnedEl) earnedEl.textContent = formatGHS(totalEarned);
      if (surveysEl) surveysEl.textContent = (earned || []).length;

      // Total withdrawn (sum of withdrawal transactions with status success)
      const { data: withdrawn } = await supabaseClient
        .from('transactions')
        .select('amount')
        .eq('user_id', currentUser.id)
        .eq('type', 'withdrawal')
        .eq('status', 'success');

      const totalWithdrawn = (withdrawn || []).reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
      const wdEl = $('#stat-withdrawn');
      if (wdEl) wdEl.textContent = formatGHS(totalWithdrawn);
    } catch (err) {
      console.error('Load stats error:', err);
    }
  }


  /* ═══════════════════════════════════════════════
     LOGOUT
     ═══════════════════════════════════════════════ */

  const logoutBtns = $$('#logout-btn, .logout-btn');
  logoutBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      await supabaseClient.auth.signOut();
      showToast('Signed out');
    });
  });


  /* ═══════════════════════════════════════════════
     INITIALIZE
     ═══════════════════════════════════════════════ */

  console.log('🚀 Credit Plug app starting...');
  init();

});
