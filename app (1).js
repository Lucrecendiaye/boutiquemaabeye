
// ========== LOGIN MODE ==========
const LoginMode = {
  _cloudInitDone: false,

  setLocal() {
    document.getElementById('tab-local').classList.add('active');
    document.getElementById('tab-cloud').classList.remove('active');
    document.getElementById('login-local-panel').classList.add('active');
    document.getElementById('login-cloud-panel').classList.remove('active');
  },

  setCloud() {
    document.getElementById('tab-cloud').classList.add('active');
    document.getElementById('tab-local').classList.remove('active');
    document.getElementById('login-cloud-panel').classList.add('active');
    document.getElementById('login-local-panel').classList.remove('active');
    const cfg = localStorage.getItem('fbk_config');
    if (cfg) {
      document.getElementById('firebase-not-configured').style.display = 'none';
      document.getElementById('firebase-configured').style.display    = 'block';
      try {
        const pid = JSON.parse(cfg).projectId || '';
        document.getElementById('fbk-project-name').textContent = '☁ ' + pid;
      } catch(_) {}
      // Init Firebase UNE SEULE FOIS
      if (!this._cloudInitDone) {
        this._cloudInitDone = true;
        try { Cloud.init(JSON.parse(cfg)); } catch(e) { console.error(e); }
      }
    } else {
      document.getElementById('firebase-not-configured').style.display = 'block';
      document.getElementById('firebase-configured').style.display    = 'none';
    }
  },

  showFirebaseSetup()  { document.getElementById('firebaseSetupModal').style.display = 'flex'; },
  hideFirebaseSetup()  { document.getElementById('firebaseSetupModal').style.display = 'none'; },

  saveFirebaseConfig() {
    const raw   = document.getElementById('fbk-config-input').value;
    const errEl = document.getElementById('fbk-setup-error');
    errEl.textContent = '';
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('Format invalide — collez le bloc firebaseConfig = { ... }');
      const cfg = eval('(' + match[0] + ')');
      if (!cfg.apiKey || !cfg.projectId) throw new Error('apiKey et projectId manquants');
      localStorage.setItem('fbk_config', JSON.stringify(cfg));
      this._cloudInitDone = false; // forcer re-init avec nouvelle config
      this.hideFirebaseSetup();
      this.setCloud();
    } catch(e) {
      errEl.textContent = 'Erreur : ' + e.message;
    }
  },

  resetFirebase() {
    if (!confirm('Retirer la configuration Firebase ?')) return;
    localStorage.removeItem('fbk_config');
    this._cloudInitDone = false;
    location.reload();
  },

  setStatus(msg, type = 'info') {
    const el = document.getElementById('login-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = type === 'error' ? 'var(--danger)' : type === 'success' ? '#4caf50' : 'var(--text2)';
  }
};

// ========== CLOUD SYNC — Firebase Firestore ==========
// Principe : Firebase EST la base de données.
// localStorage = cache lecture uniquement.
// Chaque write/delete va directement dans Firestore.
// onSnapshot = réception temps réel des autres appareils.
const Cloud = {
  db:     null,
  auth:   null,
  user:   null,
  _unsubs: {},
  _ready:  false,   // true dès que l'init est terminée et qu'on peut écrire
  _initialized: false,
  COLS:   ['products', 'sales', 'expenses', 'invoices', 'stockHistory', 'credits', 'deletedSales'],

  /* ══════════ INIT ══════════ */
  init(config) {
    if (this._initialized) return; // Ne jamais initialiser deux fois
    if (typeof firebase === 'undefined') {
      console.error('[Cloud] Firebase SDK non chargé');
      LoginMode.setStatus('Erreur : Firebase SDK absent de la page', 'error');
      return;
    }
    this._initialized = true;
    try {
      // Initialiser l'app Firebase (une seule fois)
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      this.db   = firebase.firestore();
      this.auth = firebase.auth();

      // Persistance hors-ligne (fonctionne en arrière-plan)
      this.db.enablePersistence({ synchronizeTabs: true })
        .catch(err => {
          if (err.code !== 'failed-precondition' && err.code !== 'unimplemented') {
            console.warn('[Cloud] Persistence non disponible:', err.code);
          }
        });

      // Surveiller l'état de connexion
      // onAuthStateChanged s'exécute immédiatement si une session est déjà active
      this.auth.onAuthStateChanged(user => {
        if (user) {
          this.user = user;
          this._enterApp(user);
        } else {
          this.user  = null;
          this._ready = false;
          this._showLoginScreen();
        }
      });

    } catch(err) {
      console.error('[Cloud] Init échoué:', err);
      LoginMode.setStatus('Erreur Firebase : ' + err.message, 'error');
    }
  },

  /* ══════════ AUTHENTIFICATION ══════════ */
  signInGoogle() {
    if (!this.auth) { LoginMode.setStatus('Firebase non initialisé', 'error'); return; }
    LoginMode.setStatus('Ouverture de la connexion Google...', 'info');
    const provider = new firebase.auth.GoogleAuthProvider();
    this.auth.signInWithPopup(provider)
      .catch(e => LoginMode.setStatus('Erreur : ' + e.message, 'error'));
  },

  signInEmail() {
    if (!this.auth) return;
    const email = (document.getElementById('fbk-email')?.value || '').trim();
    const pass  =  document.getElementById('fbk-pass')?.value || '';
    if (!email || !pass) { LoginMode.setStatus('Email et mot de passe requis', 'error'); return; }
    LoginMode.setStatus('Connexion en cours...', 'info');
    this.auth.signInWithEmailAndPassword(email, pass)
      .catch(e => LoginMode.setStatus('Erreur : ' + e.message, 'error'));
  },

  signUpEmail() {
    if (!this.auth) return;
    const email = (document.getElementById('fbk-email')?.value || '').trim();
    const pass  =  document.getElementById('fbk-pass')?.value || '';
    if (!email || pass.length < 6) {
      LoginMode.setStatus('Email requis, mot de passe min 6 caractères', 'error'); return;
    }
    LoginMode.setStatus('Création du compte...', 'info');
    this.auth.createUserWithEmailAndPassword(email, pass)
      .catch(e => LoginMode.setStatus('Erreur : ' + e.message, 'error'));
  },

  signOut() {
    if (!confirm('Se déconnecter du cloud ?')) return;
    this._stopListeners();
    this._ready       = false;
    this._initialized = false;
    this.user         = null;
    LoginMode._cloudInitDone = false;
    if (this.auth) this.auth.signOut();
  },

  /* ══════════ CYCLE DE VIE ══════════ */
  async _enterApp(user) {
    console.log('[Cloud] Connexion : ' + user.email);
    this._indicator('uploading');

    // Mettre à jour l'interface utilisateur
    App.currentUser = { name: user.displayName || user.email.split('@')[0], role: 'admin' };
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    setText('userName',  App.currentUser.name);
    setText('userRole',  '☁ ' + user.email);
    setText('userAvatar', App.currentUser.name[0].toUpperCase());

    // Afficher l'application, masquer le login
    const loginEl = document.getElementById('loginScreen');
    const appEl   = document.getElementById('mainApp');
    if (loginEl) loginEl.style.display = 'none';
    if (appEl)   appEl.classList.remove('hidden');

    // Basculer les boutons de déconnexion
    const btnL = document.getElementById('btn-local-logout');
    const btnC = document.getElementById('btn-cloud-logout');
    if (btnL) btnL.style.display = 'none';
    if (btnC) btnC.style.display = '';

    // 1. Charger TOUTES les données depuis Firestore
    await this._loadAll();

    // 2. Marquer comme prêt AVANT de démarrer les listeners
    this._ready = true;

    // 3. Démarrer les listeners temps réel (autres appareils)
    this._startListeners();

    // 4. Rendre l'interface
    App.loadSettings();
    Dashboard.render();
    App.showPage('dashboard');

    this._indicator(true);
    Toast.show('☁ Connecté · ' + user.email + ' · Synchronisation active');
    console.log('[Cloud] Prêt. _ready=true');
  },

  _showLoginScreen() {
    this._ready = false;
    this._stopListeners();
    this._indicator(false);

    const loginEl = document.getElementById('loginScreen');
    const appEl   = document.getElementById('mainApp');
    if (loginEl) loginEl.style.display = '';
    if (appEl)   appEl.classList.add('hidden');

    const btnL = document.getElementById('btn-local-logout');
    const btnC = document.getElementById('btn-cloud-logout');
    if (btnL) btnL.style.display = '';
    if (btnC) btnC.style.display = 'none';

    // Si Firebase est configuré → aller directement sur l'onglet Cloud
    if (localStorage.getItem('fbk_config')) {
      setTimeout(() => LoginMode.setCloud(), 100);
    }
  },

  /* ══════════ CHARGEMENT INITIAL ══════════ */
  async _loadAll() {
    if (!this.db || !this.user) return;
    const uid = this.user.uid;
    console.log('[Cloud] Chargement depuis Firestore...');

    for (const col of this.COLS) {
      try {
        const snap = await this.db
          .collection('users').doc(uid).collection(col)
          .get(); // pas de { source:'server' } — laisser Firestore gérer le cache

        if (!snap.empty) {
          DB.data[col] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          console.log('[Cloud] Chargé ' + col + ' : ' + DB.data[col].length + ' docs');
        } else {
          // Collection vide sur Firebase → envoyer les données locales
          const local = DB.data[col] || [];
          if (local.length > 0) {
            console.log('[Cloud] Push local → Firestore : ' + col + ' (' + local.length + ' docs)');
            await this._batchWrite(col, local);
          }
        }
      } catch(err) {
        console.warn('[Cloud] _loadAll ' + col + ' :', err.message);
      }
    }

    // Paramètres — avec retry automatique si hors ligne au démarrage
    let settingsLoaded = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const snap = await this.db
          .collection('users').doc(uid).collection('meta').doc('settings').get();
        if (snap.exists) {
          DB.data.settings = Object.assign({}, DB.defaults.settings, snap.data());
        } else {
          await this._writeDoc('meta', 'settings', DB.data.settings || {});
        }
        settingsLoaded = true;
        break;
      } catch(err) {
        console.warn('[Cloud] settings tentative ' + (attempt+1) + ' :', err.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 1500));
      }
    }
    if (!settingsLoaded) {
      console.warn('[Cloud] settings non disponibles — paramètres locaux conservés');
    }

    // Mettre à jour le cache local
    localStorage.setItem(DB.key, JSON.stringify(DB.data));
    console.log('[Cloud] _loadAll terminé');
  },

  /* ══════════ LISTENERS TEMPS RÉEL ══════════ */
  _startListeners() {
    if (!this.db || !this.user) return;
    const uid = this.user.uid;
    this._stopListeners();
    console.log('[Cloud] Démarrage des listeners temps réel...');

    this.COLS.forEach(col => {
      this._unsubs[col] = this.db
        .collection('users').doc(uid).collection(col)
        .onSnapshot(snap => {
          const items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          const oldCount = (DB.data[col] || []).length;
          DB.data[col] = items;
          localStorage.setItem(DB.key, JSON.stringify(DB.data));
          console.log('[Cloud] SYNC reçue — ' + col + ' : ' + items.length + ' docs (avant: ' + oldCount + ')');
          // Rafraîchir TOUTES les vues qui dépendent de cette collection
          this._refreshAll();
          this._indicator(true);
        }, err => console.warn('[Cloud] listener ' + col + ' ERREUR:', err.message));
    });

    // Listener paramètres
    this._unsubs['_settings'] = this.db
      .collection('users').doc(uid).collection('meta').doc('settings')
      .onSnapshot(snap => {
        if (snap.exists) {
          DB.data.settings = Object.assign({}, DB.defaults.settings, snap.data());
          localStorage.setItem(DB.key, JSON.stringify(DB.data));
          App.loadSettings();
          console.log('[Cloud] SYNC settings reçue');
        }
      }, err => console.warn('[Cloud] listener settings ERREUR:', err.message));

    console.log('[Cloud] Listeners actifs — en attente de changements des autres appareils');
  },

  _stopListeners() {
    Object.values(this._unsubs).forEach(u => { try { u(); } catch(_) {} });
    this._unsubs = {};
  },

  /* ══════════ ÉCRITURE / SUPPRESSION ══════════ */
  // Écrire ou mettre à jour un document unique
  async writeDoc(col, item) {
    if (!this.db || !this.user) {
      console.warn('[Cloud] writeDoc ignoré — pas connecté');
      return;
    }
    if (!this._ready) {
      console.warn('[Cloud] writeDoc ignoré — pas encore prêt (_ready=false)');
      return;
    }
    const uid   = this.user.uid;
    const docId = String(item.id || Utils.id());
    try {
      await this.db
        .collection('users').doc(uid).collection(col).doc(docId)
        .set(item);
      this._indicator(true);
    } catch(err) {
      console.error('[Cloud] writeDoc ' + col + '/' + docId + ' :', err.message);
      this._indicator('error');
      Toast.show('⚠ Erreur sync : ' + err.message, 'error');
    }
  },

  // Supprimer un document
  async deleteDoc(col, docId) {
    if (!this.db || !this.user || !this._ready) {
      console.warn('[Cloud] deleteDoc ignoré — pas prêt');
      return;
    }
    const uid = this.user.uid;
    try {
      await this.db
        .collection('users').doc(uid).collection(col).doc(String(docId))
        .delete();
    } catch(err) {
      console.error('[Cloud] deleteDoc ' + col + '/' + docId + ' :', err.message);
    }
  },

  // Écrire un document dans une collection spéciale (meta/settings)
  async _writeDoc(col, docId, data) {
    if (!this.db || !this.user) return;
    try {
      await this.db
        .collection('users').doc(this.user.uid).collection(col).doc(docId)
        .set(data);
    } catch(err) {
      console.warn('[Cloud] _writeDoc ' + col + '/' + docId + ' :', err.message);
    }
  },

  // Écriture en batch (chargement initial)
  async _batchWrite(col, items) {
    if (!this.db || !this.user) return;
    const uid = this.user.uid;
    for (let i = 0; i < items.length; i += 400) {
      const chunk = items.slice(i, i + 400);
      const batch = this.db.batch();
      chunk.forEach(item => {
        const docId = String(item.id || Utils.id());
        batch.set(this.db.collection('users').doc(uid).collection(col).doc(docId), item);
      });
      await batch.commit();
    }
  },

  /* ══════════ SYNCHRONISATION MANUELLE ══════════ */
  async manualSync() {
    if (!this.db || !this.user) {
      Toast.show('Non connecté au cloud', 'error');
      return;
    }
    this._indicator('syncing');
    const btn = document.getElementById('sync-btn');
    if (btn) btn.disabled = true;

    try {
      // 1. Pousser toutes les données locales vers Firestore
      for (const col of this.COLS) {
        const items = DB.data[col] || [];
        if (items.length > 0) await this._batchWrite(col, items);
      }
      await this._writeDoc('meta', 'settings', DB.data.settings || {});

      // 2. Recharger depuis Firestore
      await this._loadAll();

      // 3. Rafraîchir l'interface
      App.loadSettings();
      this._refreshCurrentPage();
      Dashboard.render && Dashboard.render();

      this._indicator(true);
      Toast.show('☁ Synchronisation réussie !', 'success');
    } catch(e) {
      console.error('[Cloud] manualSync:', e);
      this._indicator('error');
      Toast.show('Erreur sync : ' + e.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  },

  /* ══════════ UTILITAIRES UI ══════════ */
  _refreshCurrentPage() {
    this._refreshAll();
  },

  _refreshAll() {
    // Rafraîchir la page active
    const active = document.querySelector('.page.active');
    if (!active) return;
    const page = active.id.replace('page-', '');
    const renderers = {
      dashboard: () => Dashboard.render(),
      products:  () => Products.render(),
      sales:     () => Sales.render(),
      expenses:  () => Expenses.render(),
      invoices:  () => Invoices.render(),
      credits:   () => Credits.render(),
    };
    if (renderers[page]) renderers[page]();
    // Toujours mettre à jour les alertes stock
    App.checkStockAlerts();
  },

  _indicator(state) {
    const dot  = document.getElementById('cloud-sync-indicator');
    const bar  = document.getElementById('auto-save-indicator');
    const btn  = document.getElementById('sync-btn');
    const icon = document.getElementById('sync-btn-icon');
    const lbl  = document.getElementById('sync-btn-label');

    if (!dot) return;

    // Cacher tout si pas connecté
    if (!state) {
      dot.style.display = 'none';
      if (bar) bar.textContent = '';
      if (btn) btn.style.display = 'none';
      return;
    }

    dot.style.display = 'block';

    if (state === 'uploading' || state === 'syncing') {
      dot.className = 'cloud-sync-dot syncing';
      dot.title     = 'Synchronisation en cours...';
      if (bar)  bar.textContent  = '☁ Sync...';
      if (btn)  { btn.style.display = ''; btn.classList.add('syncing'); }
      if (icon) icon.style.animation = 'spin 1s linear infinite';
      if (lbl)  lbl.textContent  = 'Sync...';
    } else if (state === 'error') {
      dot.className = 'cloud-sync-dot error';
      dot.title     = 'Erreur de synchronisation';
      if (bar)  bar.textContent  = '⚠ Erreur sync';
      if (btn)  { btn.style.display = ''; btn.classList.remove('syncing'); btn.classList.add('error'); }
      if (icon) { icon.style.animation = ''; icon.textContent = '⚠'; }
      if (lbl)  lbl.textContent  = 'Erreur';
    } else {
      // État normal = synchronisé
      dot.className = 'cloud-sync-dot synced';
      dot.title     = '☁ Synchronisé — ' + (this.user?.email || '');
      if (bar)  bar.textContent  = '☁ ' + (this.user?.displayName || this.user?.email?.split('@')[0] || 'Synchronisé');
      if (btn)  {
        btn.style.display = '';
        btn.classList.remove('syncing', 'error');
      }
      if (icon) { icon.style.animation = ''; icon.textContent = '↻'; }
      if (lbl)  lbl.textContent  = 'Synchroniser';
    }
  }
};

// =============================================
// BOUTIQUE MANAGER PRO — app.js
// =============================================

// ========== DATA STORE ==========
const DB = {
  key: 'boutiqueManagerData',
  defaults: {
    settings: {
      shopName: 'Ma Boutique',
      address: 'Dakar, Sénégal',
      phone: '+221 XX XXX XX XX',
      email: 'boutique@email.com',
      logo: '',
      stockThreshold: 5,
      password: '1234',
      deletePassword: 'del123',
      role: 'admin'
    },
    products: [],
    sales: [],
    clients: [],
    expenses: [],
    invoices: [],
    stockHistory: [],
    credits: [],
    deletedSales: []
  },
  data: null,
  // Garder une copie de l'état précédent pour détecter les suppressions
  _prev: {},

  load() {
    try {
      const saved = localStorage.getItem(this.key);
      this.data = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(this.defaults));
      for (const k in this.defaults) {
        if (this.data[k] === undefined) this.data[k] = this.defaults[k];
      }
    } catch(e) {
      this.data = JSON.parse(JSON.stringify(this.defaults));
    }
    return this.data;
  },

  save() {
    localStorage.setItem(this.key, JSON.stringify(this.data));
    AutoBackup.onDataChange();
  },

  get(key) { return this.data[key]; },

  // set() : sauvegarde locale + sync Firestore intelligente
  set(key, val) {
    const ARRAY_COLS = ['products','sales','expenses','invoices','stockHistory','credits'];
    const prev = this.data[key];
    this.data[key] = val;
    this.save();

    // Pas de sync si cloud pas prêt
    if (typeof Cloud === 'undefined' || !Cloud._ready) return;

    // Paramètres boutique
    if (key === 'settings') {
      Cloud._writeDoc('meta', 'settings', val || {});
      return;
    }

    if (!ARRAY_COLS.includes(key)) return;

    const newArr = Array.isArray(val)  ? val  : [];
    const oldArr = Array.isArray(prev) ? prev : [];

    // Construire map des anciens docs
    const oldMap = {};
    oldArr.forEach(item => { if (item.id) oldMap[item.id] = item; });

    // Écrire les docs nouveaux ou modifiés
    newArr.forEach(item => {
      if (!item.id) return;
      const old = oldMap[item.id];
      if (!old || JSON.stringify(old) !== JSON.stringify(item)) {
        Cloud.writeDoc(key, item);
      }
    });

    // Supprimer les docs effacés localement
    const newIds = new Set(newArr.map(i => i.id).filter(Boolean));
    oldArr.forEach(item => {
      if (item.id && !newIds.has(item.id)) {
        Cloud.deleteDoc(key, item.id);
      }
    });
  }
};

// ========== UTILITIES ==========
const Utils = {
  id: () => Date.now().toString(36) + Math.random().toString(36).substr(2),
  
  // Clean number format - no special chars, readable everywhere
  fmt: (n) => {
    const num = Math.round(n || 0);
    const formatted = num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return formatted + ' FCFA';
  },

  // Format for invoice HTML - pure digits with space separator
  fmtInv: (n) => {
    const num = Math.round(n || 0);
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '\u202F') + ' FCFA';
  },

  date: (d) => {
    if (!d) return '';
    const parts = d.split('-');
    if (parts.length === 3) return parts[2] + '/' + parts[1] + '/' + parts[0];
    return d;
  },
  today: () => new Date().toISOString().split('T')[0],
  
  dateInRange(dateStr, from, to) {
    if (!from && !to) return true;
    const d = new Date(dateStr);
    if (from && d < new Date(from)) return false;
    if (to && d > new Date(to + 'T23:59:59')) return false;
    return true;
  },

  getPeriodDates(period) {
    const now = new Date();
    let from = new Date();
    switch(period) {
      case 'day':      from = new Date(now.getFullYear(), now.getMonth(), now.getDate()); break;
      case 'week': {
        const day = now.getDay() === 0 ? 6 : now.getDay() - 1; // Monday = 0
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - day);
        break;
      }
      case 'month':    from = new Date(now.getFullYear(), now.getMonth(), 1); break;
      case 'quarter':  from = new Date(now.getFullYear(), Math.floor(now.getMonth()/3)*3, 1); break;
      case 'semester': from = new Date(now.getFullYear(), now.getMonth() < 6 ? 0 : 6, 1); break;
      case 'year':     from = new Date(now.getFullYear(), 0, 1); break;
      default:         from = new Date(0);
    }
    return { from, to: now };
  },

  // Safe escape - only escapes truly dangerous chars, preserves accents
  escHtml(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // Safe for use inside HTML attributes only
  escAttr(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
};

// ========== TOAST ==========
const Toast = {
  show(msg, type='success') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => { t.className = 'toast'; }, 3000);
  }
};

// ========== APP CORE ==========
const App = {
  currentUser: null,
  sidebarOpen: false,
  chartInstances: {},

  init() {
    DB.load();
    this.loadSettings();
    this.updateClock();
    setInterval(() => this.updateClock(), 1000);
    // Navigation
    document.querySelectorAll('.nav-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        this.showPage(el.dataset.page);
      });
    });
    // Load demo data only if empty AND firebase is not configured
    const _hasFbk = !!localStorage.getItem('fbk_config');
    if (DB.get('products').length === 0 && !_hasFbk) this.loadDemoData();
  },

  loadSettings() {
    const s = DB.get('settings');
    document.getElementById('brandName').textContent = s.shopName;
    const setv = (id, v) => { const el = document.getElementById(id); if(el) el.value = v || ''; };
    setv('set-shopname',        s.shopName);
    setv('set-address',         s.address);
    setv('set-phone',           s.phone);
    setv('set-email',           s.email);
    setv('set-website',         s.website || '');
    setv('set-ninea',           s.ninea   || '');
    setv('set-stock-threshold', s.stockThreshold || 5);
  },

  login() {
    const user = document.getElementById('loginUser').value.trim();
    const pass = document.getElementById('loginPass').value;
    const s = DB.get('settings');
    if ((user === 'admin' && pass === s.password) || (user === 'vendeur' && pass === 'vendeur123')) {
      this.currentUser = { name: user === 'admin' ? 'Admin' : 'Vendeur', role: user === 'admin' ? 'admin' : 'vendor' };
      document.getElementById('loginScreen').style.display = 'none';
      document.getElementById('mainApp').classList.remove('hidden');
      document.getElementById('userName').textContent = this.currentUser.name;
      document.getElementById('userRole').textContent = this.currentUser.role === 'admin' ? 'Administrateur' : 'Vendeur';
      document.getElementById('userAvatar').textContent = this.currentUser.name[0].toUpperCase();
      this.showPage('dashboard');
    } else {
      Toast.show('Identifiants incorrects', 'error');
    }
  },

  logout() {
    this.currentUser = null;
    document.getElementById('loginScreen').style.display = '';
    document.getElementById('mainApp').classList.add('hidden');
  },

  showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById(`page-${page}`);
    if (pageEl) pageEl.classList.add('active');
    const navEl = document.querySelector(`[data-page="${page}"]`);
    if (navEl) navEl.classList.add('active');
    if (this.sidebarOpen) this.toggleSidebar();
    // Render page
    const renderers = {
      dashboard: Dashboard.render.bind(Dashboard),
      products: Products.render.bind(Products),
      sales: Sales.render.bind(Sales),
      credits: Credits.render.bind(Credits),
      expenses: Expenses.render.bind(Expenses),
      invoices: Invoices.render.bind(Invoices),
      settings: () => { this.loadSettings(); Settings.loadLogoPreview(); AutoBackup.renderPanel(); }
    };
    if (renderers[page]) renderers[page]();
  },

  toggleSidebar() {
    this.sidebarOpen = !this.sidebarOpen;
    document.getElementById('sidebar').classList.toggle('open', this.sidebarOpen);
  },

  setTheme(theme) {
    document.body.setAttribute('data-theme', theme);
    localStorage.setItem('boutiqueTheme', theme);
    // Refresh charts
    setTimeout(() => Dashboard.renderCharts(), 100);
  },

  updateClock() {
    const now = new Date();
    document.getElementById('clock').textContent = now.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});
  },

  openModal(id) {
    document.getElementById('modalOverlay').classList.add('active');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
    if (id) document.getElementById(id).classList.remove('hidden');
  },

  closeModal(e) {
    // Si appelé depuis un événement (clic overlay), ignorer — fermeture uniquement via boutons
    if (e && e.type === 'click') return;
    document.getElementById('modalOverlay').classList.remove('active');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  },

  forceCloseModal() {
    document.getElementById('modalOverlay').classList.remove('active');
    document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  },

  checkStockAlerts() {
    const prods = DB.get('products');
    const threshold = DB.get('settings').stockThreshold;
    const lowStock = prods.filter(p => p.stock <= threshold);
    const badge = document.getElementById('stockAlertBadge');
    if (lowStock.length > 0) {
      badge.style.display = '';
      document.getElementById('stockAlertCount').textContent = lowStock.length;
    } else {
      badge.style.display = 'none';
    }
    return lowStock;
  },

  globalSearch(q) {
    const res = document.getElementById('searchResults');
    if (!q || q.length < 2) { res.classList.remove('active'); return; }
    const prods = DB.get('products').filter(p => p.name.toLowerCase().includes(q.toLowerCase()));
    const sales  = DB.get('sales').filter(s => (s.client||'').toLowerCase().includes(q.toLowerCase()));
    let html = '';
    prods.slice(0,5).forEach(p => {
      html += `<div class="search-result-item" onclick="App.showPage('products')">
        🏷️ <strong>${Utils.escHtml(p.name)}</strong> — Stock: ${p.stock}</div>`;
    });
    sales.slice(0,3).forEach(s => {
      html += `<div class="search-result-item" onclick="App.showPage('sales')">
        💰 <strong>${Utils.escHtml(s.client||'—')}</strong> — ${Utils.fmt(s.total)}</div>`;
    });
    if (!html) html = '<div class="search-result-item">Aucun résultat</div>';
    res.innerHTML = html;
    res.classList.add('active');
    document.addEventListener('click', function h(e) {
      if (!res.contains(e.target)) { res.classList.remove('active'); document.removeEventListener('click', h); }
    });
  },

  loadDemoData() {
    // Demo products
    const demoProducts = [
      {id:Utils.id(), name:'Lingerie ensemble dentelle', category:'Lingerie', priceDetail:8000, priceGros:5500, cost:3500, stock:15, alertThreshold:5, notes:''},
      {id:Utils.id(), name:'Gaine amincissante', category:'Gaine', priceDetail:12000, priceGros:9000, cost:6000, stock:8, alertThreshold:3, notes:''},
      {id:Utils.id(), name:'Peignoir en soie', category:'Peignoir', priceDetail:15000, priceGros:11000, cost:7000, stock:6, alertThreshold:3, notes:''},
      {id:Utils.id(), name:'Serviette 3pcs', category:'Serviette', priceDetail:5000, priceGros:3500, cost:2000, stock:20, alertThreshold:5, notes:''},
      {id:Utils.id(), name:'Cuissard coton dentelle', category:'Cuissard', priceDetail:4500, priceGros:3000, cost:1800, stock:3, alertThreshold:5, notes:''},
      {id:Utils.id(), name:'Parfum importé 50ml', category:'Parfum', priceDetail:18000, priceGros:14000, cost:9000, stock:12, alertThreshold:4, notes:''},
      {id:Utils.id(), name:'Ensemble 2pcs lingerie', category:'Ensemble', priceDetail:9500, priceGros:7000, cost:4500, stock:10, alertThreshold:4, notes:''},
      {id:Utils.id(), name:'Nuisette satin', category:'Nuisette/Pyjama', priceDetail:7000, priceGros:5000, cost:3000, stock:2, alertThreshold:5, notes:''},
      {id:Utils.id(), name:'Sac à main tendance', category:'Sac', priceDetail:22000, priceGros:17000, cost:11000, stock:5, alertThreshold:3, notes:''},
    ];
    DB.set('products', demoProducts);

    // Demo sales (last 30 days)
    const clientNames = ['Fatou Diallo', 'Aminata Sow', 'Rokhaya Ndiaye', 'Mariama Ba'];
    const prods = demoProducts;
    const demoSales = [];
    for (let i = 0; i < 15; i++) {
      const date = new Date();
      date.setDate(date.getDate() - Math.floor(Math.random()*30));
      const prod = prods[Math.floor(Math.random()*prods.length)];
      const qty = Math.floor(Math.random()*3)+1;
      const type = Math.random() > 0.3 ? 'detail' : 'gros';
      const price = type === 'detail' ? prod.priceDetail : prod.priceGros;
      demoSales.push({
        id: Utils.id(),
        date: date.toISOString().split('T')[0],
        client: clientNames[Math.floor(Math.random()*clientNames.length)],
        type,
        items: [{productId: prod.id, productName: prod.name, qty, price, cost: prod.cost}],
        discount: 0,
        payment: 'Espèces',
        notes: '',
        total: price * qty,
        profit: (price - prod.cost) * qty
      });
    }
    DB.set('sales', demoSales);

    // Demo expenses
    const demoExpenses = [
      {id:Utils.id(), date: Utils.today(), description:'Loyer boutique', category:'Loyer', amount:50000},
      {id:Utils.id(), date: Utils.today(), description:'Transport livraison', category:'Transport', amount:3500},
    ];
    DB.set('expenses', demoExpenses);
  }
};

// ========== DASHBOARD ==========
const Dashboard = {
  period: 'month',
  salesChart: null,
  categoryChart: null,

  render() {
    this.renderKPIs();
    this.renderCharts();
    this.renderTopProducts();
    this.renderRecentSales();
    this.renderStockAlerts();
    App.checkStockAlerts();
  },

  setPeriod(period, btn) {
    this.period = period;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    this.render();
  },

  getFilteredData() {
    const { from, to } = Utils.getPeriodDates(this.period);
    const sales = DB.get('sales').filter(s => {
      const d = new Date(s.date);
      return d >= from && d <= to;
    });
    const expenses = DB.get('expenses').filter(e => {
      const d = new Date(e.date);
      return d >= from && d <= to;
    });
    return { sales, expenses };
  },

  renderKPIs() {
    const { sales, expenses } = this.getFilteredData();
    const totalSales = sales.reduce((a,s) => a + (s.total||0), 0);
    const totalExpenses = expenses.reduce((a,e) => a + (e.amount||0), 0);
    const totalProfit = sales.reduce((a,s) => a + (s.profit||0), 0) - totalExpenses;

    document.getElementById('kpi-sales-val').textContent = Utils.fmt(totalSales);
    document.getElementById('kpi-profit-val').textContent = Utils.fmt(totalProfit);
    document.getElementById('kpi-expenses-val').textContent = Utils.fmt(totalExpenses);
    document.getElementById('kpi-orders-val').textContent = sales.length;
  },

  renderCharts() {
    this.renderSalesChart();
    this.renderDaysTable();
    this.renderCategoryChart();
  },

  renderSalesChart() {
    const canvas = document.getElementById('salesChart');
    if (!canvas) return;
    if (this.salesChart) this.salesChart.destroy();

    const allSales = DB.get('sales');
    const style    = getComputedStyle(document.body);
    const accent   = style.getPropertyValue('--accent').trim() || '#c8a4a5';
    const period   = this.period || 'month';

    let labels = [], data = [], profitData = [], chartType = 'line';

    if (period === 'week') {
      const now = new Date();
      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1;
      const monday = new Date(now);
      monday.setDate(now.getDate() - dayOfWeek);
      monday.setHours(0,0,0,0);
      const dayNames = ['Lun','Mar','Mer','Jeu','Ven','Sam','Dim'];
      for (let i = 0; i < 7; i++) {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        const dayStr = day.toISOString().split('T')[0];
        labels.push(dayNames[i] + ' ' + day.getDate());
        const ds = allSales.filter(s => s.date === dayStr);
        data.push(ds.reduce((a,s) => a + (s.total||0), 0));
        profitData.push(ds.reduce((a,s) => a + (s.profit||0), 0));
      }
      chartType = 'bar';
    } else if (period === 'day') {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];
      const todaySales = allSales.filter(s => s.date === todayStr);
      for (let h = 0; h < 24; h += 4) {
        labels.push(String(h).padStart(2,'0') + 'h');
        data.push(h === 0 ? todaySales.reduce((a,s) => a+(s.total||0), 0) : 0);
        profitData.push(h === 0 ? todaySales.reduce((a,s) => a+(s.profit||0), 0) : 0);
      }
      chartType = 'bar';
    } else if (period === 'month') {
      const now = new Date();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        labels.push(String(d));
        const ds = allSales.filter(s => s.date === dateStr);
        data.push(ds.reduce((a,s) => a+(s.total||0), 0));
        profitData.push(ds.reduce((a,s) => a+(s.profit||0), 0));
      }
    } else {
      const nbMonths = period === 'quarter' ? 3 : period === 'semester' ? 6 : 12;
      for (let i = nbMonths-1; i >= 0; i--) {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
        labels.push(d.toLocaleDateString('fr-FR', {month:'short', year:'2-digit'}));
        const ms = allSales.filter(s => {
          const sd = new Date(s.date);
          return sd.getMonth() === d.getMonth() && sd.getFullYear() === d.getFullYear();
        });
        data.push(ms.reduce((a,s) => a+(s.total||0), 0));
        profitData.push(ms.reduce((a,s) => a+(s.profit||0), 0));
      }
    }

    this.salesChart = new Chart(canvas, {
      type: chartType,
      data: {
        labels,
        datasets: [
          {
            label: 'Ventes (FCFA)',
            data,
            borderColor: accent,
            backgroundColor: chartType === 'bar' ? accent + 'bb' : accent + '22',
            borderWidth: chartType === 'bar' ? 0 : 2.5,
            borderRadius: chartType === 'bar' ? 5 : 0,
            pointBackgroundColor: accent,
            pointRadius: chartType === 'bar' ? 0 : 3,
            fill: chartType !== 'bar',
            tension: 0.4,
            order: 2,
            yAxisID: 'y'
          },
          {
            label: 'Bénéfices (FCFA)',
            data: profitData,
            borderColor: '#4caf50',
            backgroundColor: chartType === 'bar' ? '#4caf5088' : '#4caf5018',
            borderWidth: chartType === 'bar' ? 0 : 2,
            borderRadius: chartType === 'bar' ? 5 : 0,
            pointBackgroundColor: '#4caf50',
            pointRadius: chartType === 'bar' ? 0 : 3,
            fill: false,
            tension: 0.4,
            order: 1,
            yAxisID: 'y'
          }
        ]
      },
      options: {
        responsive: true,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'top',
            labels: { color: '#999', font: { size: 11 }, boxWidth: 12, padding: 16 }
          },
          tooltip: {
            callbacks: {
              label: ctx => ' ' + ctx.dataset.label + ' : ' + Utils.fmt(ctx.parsed.y)
            }
          }
        },
        scales: {
          x: { grid: { color: 'rgba(128,128,128,0.08)' }, ticks: { color: '#999', font:{size:11} } },
          y: { grid: { color: 'rgba(128,128,128,0.08)' }, ticks: { color: '#999', callback: v => v >= 1000 ? (v/1000).toFixed(0)+'k' : v } }
        }
      }
    });
  },

  renderDaysTable() {
    const section = document.getElementById('week-days-table');
    if (!section) return;
    const period = this.period || 'month';
    if (period !== 'week' && period !== 'month') { section.style.display = 'none'; return; }
    section.style.display = 'block';

    const now      = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const allSales = DB.get('sales') || [];
    const rows = [];

    if (period === 'week') {
      const dayOfWeek = now.getDay() === 0 ? 6 : now.getDay() - 1;
      const monday = new Date(now);
      monday.setDate(now.getDate() - dayOfWeek);
      monday.setHours(0,0,0,0);
      const dayNames = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];
      for (let i = 0; i < 7; i++) {
        const day = new Date(monday);
        day.setDate(monday.getDate() + i);
        const dayStr = day.toISOString().split('T')[0];
        const ds = allSales.filter(s => s.date === dayStr);
        rows.push({
          name:    dayNames[i],
          dayStr,
          nb:      ds.length,
          ventes:  ds.reduce((a,s) => a+(s.total||0), 0),
          benef:   ds.reduce((a,s) => a+(s.profit||0), 0),
          isToday: dayStr === todayStr
        });
      }
      const titleEl = document.getElementById('days-table-title');
      if (titleEl) titleEl.textContent = 'Détail des ventes — semaine en cours';
    } else {
      // Mois complet
      const y = now.getFullYear(), m = now.getMonth();
      const daysInMonth = new Date(y, m+1, 0).getDate();
      const dayNames = ['Dim','Lun','Mar','Mer','Jeu','Ven','Sam'];
      for (let d = 1; d <= daysInMonth; d++) {
        const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const dayName = dayNames[new Date(dateStr).getDay()];
        const ds = allSales.filter(s => s.date === dateStr);
        rows.push({
          name:    dayName + ' ' + d,
          dayStr:  dateStr,
          nb:      ds.length,
          ventes:  ds.reduce((a,s) => a+(s.total||0), 0),
          benef:   ds.reduce((a,s) => a+(s.profit||0), 0),
          isToday: dateStr === todayStr
        });
      }
      const titleEl = document.getElementById('days-table-title');
      const mName = now.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      if (titleEl) titleEl.textContent = 'Détail des ventes — ' + mName;
    }

    const tbody = document.getElementById('week-days-tbody');
    if (!tbody) return;
    tbody.innerHTML = rows.map(r => `
      <tr class="${r.isToday ? 'wdt-today' : ''}${r.nb === 0 ? ' wdt-empty' : ''}">
        <td class="wdt-day">${r.name} <small style="color:var(--text2);font-size:0.72rem">${r.dayStr.slice(5).replace('-','/')}</small></td>
        <td class="wdt-nb">${r.nb > 0 ? r.nb + ' vente' + (r.nb>1?'s':'') : '<span style="color:var(--text2);font-size:0.8rem">—</span>'}</td>
        <td class="wdt-amt ${r.ventes>0?'wdt-pos':''}">${r.ventes > 0 ? Utils.fmt(r.ventes) : '<span style="color:var(--border)">0</span>'}</td>
        <td class="wdt-benef ${r.benef>0?'wdt-green':r.benef<0?'wdt-red':''}">${r.benef !== 0 ? Utils.fmt(r.benef) : '<span style="color:var(--border)">0</span>'}</td>
      </tr>`).join('');

    const totalV = rows.reduce((a,r)=>a+r.ventes,0);
    const totalB = rows.reduce((a,r)=>a+r.benef,0);
    const totalN = rows.reduce((a,r)=>a+r.nb,0);
    const tfoot  = document.getElementById('week-days-tfoot');
    const label  = period === 'week' ? 'Total semaine' : 'Total mois';
    if (tfoot) tfoot.innerHTML = `
      <tr>
        <td><strong>${label}</strong></td>
        <td><strong>${totalN} vente${totalN>1?'s':''}</strong></td>
        <td><strong style="color:var(--accent)">${Utils.fmt(totalV)}</strong></td>
        <td><strong style="color:#4caf50">${Utils.fmt(totalB)}</strong></td>
      </tr>`;
  },

  renderCategoryChart() {
    const canvas = document.getElementById('categoryChart');
    if (!canvas) return;
    if (this.categoryChart) this.categoryChart.destroy();

    const { sales } = this.getFilteredData();
    const catMap = {};
    sales.forEach(s => {
      (s.items||[]).forEach(item => {
        const prod = DB.get('products').find(p => p.id === item.productId);
        const cat = prod ? prod.category : 'Autre';
        catMap[cat] = (catMap[cat]||0) + (item.qty * item.price);
      });
    });
    const labels = Object.keys(catMap);
    const data = Object.values(catMap);
    const colors = ['#c8a4a5','#9b7fe8','#d4af37','#7ec8a4','#e87a7a','#7ab4e8','#f0c274','#c89b7e','#a4c8b0'];

    this.categoryChart = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: colors, borderWidth: 0 }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'bottom', labels: { color: '#999', font:{size:11}, padding:10 } }
        }
      }
    });
  },

  renderTopProducts() {
    const { sales } = this.getFilteredData();
    const prodMap = {};
    sales.forEach(s => {
      (s.items||[]).forEach(item => {
        prodMap[item.productName] = (prodMap[item.productName]||0) + item.qty;
      });
    });
    const sorted = Object.entries(prodMap).sort((a,b)=>b[1]-a[1]).slice(0,5);
    const el = document.getElementById('topProducts');
    if (!sorted.length) { el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📦</div>Aucune vente</div>'; return; }
    el.innerHTML = sorted.map(([name, qty], i) => `
      <div class="top-product-item">
        <div style="display:flex;align-items:center;gap:0.5rem">
          <div class="top-product-rank">${i+1}</div>
          <span>${Utils.escHtml(name)}</span>
        </div>
        <span style="color:var(--accent);font-weight:600">${qty} vendus</span>
      </div>`).join('');
  },

  renderRecentSales() {
    const sales = DB.get('sales').slice(-5).reverse();
    const el = document.getElementById('recentSales');
    if (!sales.length) { el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">🛍</div>Aucune vente</div>'; return; }
    el.innerHTML = sales.map(s => `
      <div class="recent-sale-item">
        <div>
          <div style="font-weight:500">${Utils.escHtml(s.client||'Client inconnu')}</div>
          <div style="font-size:0.75rem;color:var(--text2)">${Utils.date(s.date)}</div>
        </div>
        <div style="text-align:right">
          <div style="color:var(--accent);font-weight:600">${Utils.fmt(s.total)}</div>
          <span class="badge-${s.type==='gros'?'info':'success'}">${s.type}</span>
        </div>
      </div>`).join('');
  },

  renderStockAlerts() {
    const prods = App.checkStockAlerts();
    const threshold = DB.get('settings').stockThreshold;
    const lowStock = DB.get('products').filter(p => p.stock <= threshold);
    const el = document.getElementById('stockAlerts');
    if (!lowStock.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">✅</div>Stock OK</div>';
      return;
    }
    el.innerHTML = lowStock.map(p => `
      <div class="alert-item">
        <span>${Utils.escHtml(p.name)}</span>
        <span class="${p.stock===0?'badge-danger':'badge-warning'}">${p.stock===0?'Rupture':p.stock+' restants'}</span>
      </div>`).join('');
  }
};

// ========== PRODUCTS ==========
const Products = {
  render() {
    this.populateCategoryFilter();
    this.filter();
    this.renderStockHistory();
    this._updateStockValues();
    App.checkStockAlerts();
  },

  _updateStockValues() {
    const prods   = DB.get('products');
    const valCost   = prods.reduce((a,p) => a + (p.cost||0)        * (p.stock||0), 0);
    const valDetail = prods.reduce((a,p) => a + (p.priceDetail||0) * (p.stock||0), 0);
    const valGros   = prods.reduce((a,p) => a + (p.priceGros||0)   * (p.stock||0), 0);
    const profit    = valDetail - valCost;
    const rupture   = prods.filter(p => p.stock === 0).length;
    const set = (id,v) => { const el = document.getElementById(id); if(el) el.textContent = v; };
    set('stock-val-cost',    Utils.fmt(valCost));
    set('stock-val-detail',  Utils.fmt(valDetail));
    set('stock-val-gros',    Utils.fmt(valGros));
    set('stock-val-profit',  Utils.fmt(profit));
    set('stock-val-refs',    prods.length);
    set('stock-val-rupture', rupture);
  },

  populateCategoryFilter() {
    const cats = [...new Set(DB.get('products').map(p=>p.category))].sort();
    const sel = document.getElementById('categoryFilter');
    if (sel) sel.innerHTML = '<option value="">Toutes catégories</option>' + cats.map(c=>`<option value="${c}">${c}</option>`).join('');
  },

  filter() {
    const q = (document.getElementById('productSearch')||{value:''}).value.toLowerCase();
    const cat = (document.getElementById('categoryFilter')||{value:''}).value;
    const stk = (document.getElementById('stockFilter')||{value:''}).value;
    const threshold = DB.get('settings').stockThreshold;
    let prods = DB.get('products').filter(p => {
      if (q && !p.name.toLowerCase().includes(q) && !p.category.toLowerCase().includes(q)) return false;
      if (cat && p.category !== cat) return false;
      if (stk === 'low' && (p.stock > threshold || p.stock === 0)) return false;
      if (stk === 'ok' && p.stock <= threshold) return false;
      if (stk === 'out' && p.stock > 0) return false;
      return true;
    });
    this.renderTable(prods);
  },

  renderTable(prods) {
    const threshold = DB.get('settings').stockThreshold;
    const tbody = document.getElementById('productsTbody');
    if (!prods.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty-state"><div class="empty-state-icon">📦</div>Aucun produit</div></td></tr>`;
      return;
    }
    tbody.innerHTML = prods.map(p => {
      const statusLabel = p.stock === 0 ? '<span class="badge-danger">Rupture</span>' :
        p.stock <= threshold ? '<span class="badge-warning">Stock faible</span>' :
        '<span class="badge-success">OK</span>';
      return `<tr>
        <td><strong>${Utils.escHtml(p.name)}</strong>${p.notes?`<br><small style="color:var(--text2)">${Utils.escHtml(p.notes)}</small>`:''}
        </td>
        <td>${Utils.escHtml(p.category)}</td>
        <td>${Utils.fmt(p.priceDetail)}</td>
        <td>${Utils.fmt(p.priceGros)}</td>
        <td>${Utils.fmt(p.cost)}</td>
        <td><strong style="font-size:1.1rem">${p.stock}</strong></td>
        <td>${statusLabel}</td>
        <td>
          <button class="btn-icon" onclick="Products.openStockModal('${p.id}')" title="Ajuster stock">📦</button>
          <button class="btn-icon" onclick="Products.openModal('${p.id}')" title="Modifier">✏️</button>
          <button class="btn-icon" onclick="Products.delete('${p.id}')" title="Supprimer">🗑️</button>
        </td>
      </tr>`;
    }).join('');
  },

  renderStockHistory() {
    const hist = DB.get('stockHistory').slice(-30).reverse();
    const tbody = document.getElementById('stockHistoryTbody');
    if (!hist.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:var(--text2);padding:1rem">Aucun mouvement</td></tr>'; return; }
    tbody.innerHTML = hist.map(h => `<tr>
      <td>${Utils.date(h.date)}</td>
      <td>${Utils.escHtml(h.productName)}</td>
      <td><span class="${h.type==='in'?'badge-success':'badge-danger'}">${h.type==='in'?'Entrée':'Sortie'}</span></td>
      <td>${h.type==='in'?'+':'—'}${h.qty}</td>
      <td>${Utils.escHtml(h.note||'—')}</td>
    </tr>`).join('');
  },

  openModal(id) {
    const isEdit = !!id;
    document.getElementById('productModalTitle').textContent = isEdit ? 'Modifier le produit' : 'Nouveau produit';
    document.getElementById('prod-id').value = '';
    document.getElementById('prod-name').value = '';
    document.getElementById('prod-category').value = '';
    document.getElementById('prod-price-detail').value = '';
    document.getElementById('prod-price-gros').value = '';
    document.getElementById('prod-cost').value = '';
    document.getElementById('prod-stock').value = '';
    document.getElementById('prod-alert').value = DB.get('settings').stockThreshold;
    document.getElementById('prod-notes').value = '';

    if (isEdit) {
      const p = DB.get('products').find(x => x.id === id);
      if (!p) return;
      document.getElementById('prod-id').value = p.id;
      document.getElementById('prod-name').value = p.name;
      document.getElementById('prod-category').value = p.category;
      document.getElementById('prod-price-detail').value = p.priceDetail;
      document.getElementById('prod-price-gros').value = p.priceGros;
      document.getElementById('prod-cost').value = p.cost;
      document.getElementById('prod-stock').value = p.stock;
      document.getElementById('prod-alert').value = p.alertThreshold;
      document.getElementById('prod-notes').value = p.notes||'';
    }
    App.openModal('productModal');
  },

  save() {
    const name = document.getElementById('prod-name').value.trim();
    const category = document.getElementById('prod-category').value.trim();
    if (!name || !category) { Toast.show('Nom et catégorie obligatoires', 'error'); return; }

    const id = document.getElementById('prod-id').value;
    const prod = {
      id: id || Utils.id(),
      name,
      category,
      priceDetail: parseFloat(document.getElementById('prod-price-detail').value) || 0,
      priceGros: parseFloat(document.getElementById('prod-price-gros').value) || 0,
      cost: parseFloat(document.getElementById('prod-cost').value) || 0,
      stock: parseInt(document.getElementById('prod-stock').value) || 0,
      alertThreshold: parseInt(document.getElementById('prod-alert').value) || 5,
      notes: document.getElementById('prod-notes').value.trim()
    };

    const prods = DB.get('products');
    if (id) {
      const idx = prods.findIndex(p => p.id === id);
      if (idx >= 0) prods[idx] = prod;
    } else {
      prods.push(prod);
    }
    DB.set('products', prods);
    App.forceCloseModal();
    this.render();
    Toast.show(id ? 'Produit modifié' : 'Produit ajouté');
  },

  delete(id) {
    if (!confirm('Supprimer ce produit ?')) return;
    DB.set('products', DB.get('products').filter(p => p.id !== id));
    this.render();
    Toast.show('Produit supprimé', 'warning');
  },

  openStockModal(id) {
    const p = DB.get('products').find(x => x.id === id);
    if (!p) return;
    document.getElementById('stock-prod-id').value = p.id;
    document.getElementById('stock-prod-name').textContent = p.name + ' — Stock actuel: ' + p.stock;
    document.getElementById('stock-qty').value = 1;
    document.getElementById('stock-note').value = '';
    App.openModal('stockModal');
  },

  saveStockMovement() {
    const id = document.getElementById('stock-prod-id').value;
    const type = document.getElementById('stock-type').value;
    const qty = parseInt(document.getElementById('stock-qty').value) || 1;
    const note = document.getElementById('stock-note').value.trim();

    const prods = DB.get('products');
    const idx = prods.findIndex(p => p.id === id);
    if (idx < 0) return;

    if (type === 'out' && prods[idx].stock < qty) {
      Toast.show('Stock insuffisant', 'error');
      return;
    }

    prods[idx].stock += type === 'in' ? qty : -qty;
    DB.set('products', prods);

    const hist = DB.get('stockHistory');
    hist.push({id: Utils.id(), date: Utils.today(), productId: id, productName: prods[idx].name, type, qty, note});
    DB.set('stockHistory', hist);

    App.forceCloseModal();
    this.render();
    Toast.show(`Stock ${type==='in'?'augmenté':'diminué'} de ${qty}`);
  },

  exportExcel() {
    const prods = DB.get('products');
    const ws = XLSX.utils.json_to_sheet(prods.map(p=>({
      Nom: p.name, Catégorie: p.category, 'Prix détail': p.priceDetail,
      'Prix gros': p.priceGros, 'Coût achat': p.cost, Stock: p.stock
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Produits');
    XLSX.writeFile(wb, 'produits.xlsx');
  }
};

// ========== SALES ==========
const Sales = {
  saleItems: [],

  render() {
    this.filter();
    this.updateClientDatalist();
  },

  updateClientDatalist() {
    const clients = [];
    ['clientNames','clientNames2'].forEach(id => {
      const dl = document.getElementById(id);
      if (dl) dl.innerHTML = '';
    });
  },

  filter() {
    const from = document.getElementById('salesDateFrom').value;
    const to = document.getElementById('salesDateTo').value;
    const type = document.getElementById('salesTypeFilter').value;
    let sales = DB.get('sales').filter(s => {
      if (!Utils.dateInRange(s.date, from, to)) return false;
      if (type && s.type !== type) return false;
      return true;
    });
    this.renderTable(sales);
    this.renderKPIs(sales);
  },

  renderTable(sales) {
    const tbody = document.getElementById('salesTbody');
    if (!sales.length) {
      tbody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><div class="empty-state-icon">🛍</div>Aucune vente</div></td></tr>`;
      return;
    }
    const sorted = [...sales].sort((a,b)=>new Date(b.date)-new Date(a.date));
    tbody.innerHTML = sorted.map(s => {
      const items = (s.items||[]).map(i=>`${Utils.escHtml(i.productName)} x${i.qty}`).join(', ');
      return `<tr>
        <td>${Utils.date(s.date)}</td>
        <td>${Utils.escHtml(s.client||'—')}</td>
        <td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${Utils.escHtml(items)}">${Utils.escHtml(items)}</td>
        <td><span class="${s.type==='gros'?'badge-info':'badge-success'}">${s.type}</span></td>
        <td><strong>${Utils.fmt(s.total)}</strong></td>
        <td>${s.discount?s.discount+'%':'—'}</td>
        <td>${Utils.escHtml(s.payment||'—')}</td>
        <td style="color:var(--success)">${Utils.fmt(s.profit)}</td>
        <td>
          <button class="btn-icon" onclick="Sales.printInvoice('${s.id}')" title="Facture">🧾</button>
          <button class="btn-icon" onclick="Sales.openModal('${s.id}')" title="Modifier">✏️</button>
          <button class="btn-icon" onclick="Sales.delete('${s.id}')" title="Supprimer">🗑️</button>
        </td>
      </tr>`;
    }).join('');
  },

  renderKPIs(sales) {
    const total = sales.reduce((a,s)=>a+(s.total||0),0);
    const detail = sales.filter(s=>s.type==='detail').reduce((a,s)=>a+(s.total||0),0);
    const gros = sales.filter(s=>s.type==='gros').reduce((a,s)=>a+(s.total||0),0);
    const benefit = sales.reduce((a,s)=>a+(s.profit||0),0);
    document.getElementById('sales-total-period').textContent = Utils.fmt(total);
    document.getElementById('sales-detail').textContent = Utils.fmt(detail);
    document.getElementById('sales-gros').textContent = Utils.fmt(gros);
    document.getElementById('sales-benefit').textContent = Utils.fmt(benefit);
  },

  openModal(id) {
    const isEdit = !!id;
    this.saleItems = [{id:Utils.id(), productId:'', qty:1, price:0, cost:0}];
    document.getElementById('sale-id').value = '';
    document.getElementById('sale-date').value = Utils.today();
    document.getElementById('sale-type').value = 'detail';
    document.getElementById('sale-client').value = '';
    document.getElementById('sale-discount').value = 0;
    document.getElementById('sale-payment').value = 'Espèces';
    document.getElementById('sale-notes').value = '';

    if (isEdit) {
      const sale = DB.get('sales').find(s => s.id === id);
      if (!sale) return;
      document.getElementById('sale-id').value = sale.id;
      document.getElementById('sale-date').value = sale.date;
      document.getElementById('sale-type').value = sale.type;
      document.getElementById('sale-client').value = sale.client||'';
      document.getElementById('sale-discount').value = sale.discount||0;
      document.getElementById('sale-payment').value = sale.payment||'Espèces';
      document.getElementById('sale-notes').value = sale.notes||'';
      this.saleItems = (sale.items||[]).map(item => ({
        id: Utils.id(),
        productId: item.productId,
        productName: item.productName,
        qty: item.qty,
        price: item.price,
        cost: item.cost
      }));
      if (!this.saleItems.length) this.saleItems = [{id:Utils.id(), productId:'', qty:1, price:0, cost:0}];
    }

    document.querySelector('#saleModal .modal-header h3').textContent = isEdit ? 'Modifier la vente' : 'Nouvelle Vente';
    this.renderItems();
    this.calcTotal();
    App.openModal('saleModal');
  },

  renderItems() {
    const prods = DB.get('products');
    const type = document.getElementById('sale-type').value;
    const container = document.getElementById('saleItemsList');
    container.innerHTML = this.saleItems.map((item, idx) => {
      const selProd = prods.find(p => p.id === item.productId);
      const displayName = selProd ? selProd.name : '';
      const stockInfo = selProd ? ` (stock: ${selProd.stock})` : '';
      return `<div class="sale-item-row" id="sir-${item.id}">
        <div class="prod-search-wrap">
          <input type="text"
            class="prod-search-input"
            value="${Utils.escHtml(displayName)}"
            placeholder="Rechercher un produit..."
            oninput="Sales.filterProds('${item.id}', this.value)"
            onfocus="Sales.openProdDrop('${item.id}')"
            autocomplete="off"
          >
          ${selProd ? `<span class="prod-search-badge">${selProd.stock} en stock</span>` : ''}
          <div class="prod-drop hidden" id="pdrop-${item.id}"></div>
        </div>
        <input type="number" min="1" value="${item.qty}" onchange="Sales.onQtyChange('${item.id}', this.value)" class="si-qty">
        <input type="number" value="${item.price}" onchange="Sales.onPriceChange('${item.id}', this.value)" class="si-price">
        <div class="sale-item-total">${Utils.fmt(item.qty * item.price)}</div>
        <button class="btn-remove-item" onclick="Sales.removeItem('${item.id}')">✕</button>
      </div>`;
    }).join('');
    // Close dropdowns on outside click
    setTimeout(() => {
      document.addEventListener('click', function _close(e) {
        if (!e.target.closest('.prod-search-wrap')) {
          document.querySelectorAll('.prod-drop').forEach(d => d.classList.add('hidden'));
        }
      }, {once:false});
    }, 100);
  },

  openProdDrop(itemId) {
    Sales.filterProds(itemId, document.querySelector(`#sir-${itemId} .prod-search-input`)?.value || '');
  },

  filterProds(itemId, query) {
    const drop = document.getElementById(`pdrop-${itemId}`);
    if (!drop) return;
    const prods = DB.get('products');
    const q = query.toLowerCase().trim();
    const type = document.getElementById('sale-type')?.value || 'detail';
    // Filter: match name, category, or partial reference
    const matches = q.length === 0 ? prods : prods.filter(p =>
      p.name.toLowerCase().includes(q) ||
      (p.category||'').toLowerCase().includes(q) ||
      (p.notes||'').toLowerCase().includes(q)
    );
    if (!matches.length) {
      drop.innerHTML = '<div class="prod-drop-empty">Aucun produit trouvé</div>';
      drop.classList.remove('hidden');
      return;
    }
    drop.innerHTML = matches.slice(0, 12).map(p => {
      const price = type === 'gros' ? p.priceGros : p.priceDetail;
      const stockCls = p.stock === 0 ? 'pdrop-out' : p.stock <= 3 ? 'pdrop-low' : '';
      return `<div class="prod-drop-item ${stockCls}" onclick="Sales.selectProd('${itemId}','${p.id}')">
        <div class="pdi-name">${Utils.escHtml(p.name)}</div>
        <div class="pdi-meta">
          <span class="pdi-cat">${Utils.escHtml(p.category)}</span>
          <span class="pdi-price">${Utils.fmt(price)}</span>
          <span class="pdi-stock ${stockCls}">${p.stock === 0 ? 'Rupture' : p.stock + ' en stock'}</span>
        </div>
      </div>`;
    }).join('');
    drop.classList.remove('hidden');
  },

  selectProd(itemId, productId) {
    const item = this.saleItems.find(i => i.id === itemId);
    if (!item) return;
    const prod = DB.get('products').find(p => p.id === productId);
    if (!prod) return;
    item.productId = productId;
    item.productName = prod.name;
    const type = document.getElementById('sale-type')?.value || 'detail';
    item.price = type === 'gros' ? prod.priceGros : prod.priceDetail;
    item.cost = prod.cost;
    // Close dropdown
    const drop = document.getElementById(`pdrop-${itemId}`);
    if (drop) drop.classList.add('hidden');
    this.renderItems();
    this.calcTotal();
  },

  addItem() {
    this.saleItems.push({id:Utils.id(), productId:'', qty:1, price:0, cost:0});
    this.renderItems();
  },

  removeItem(id) {
    if (this.saleItems.length === 1) { Toast.show('Au moins un article requis', 'warning'); return; }
    this.saleItems = this.saleItems.filter(i=>i.id!==id);
    this.renderItems();
    this.calcTotal();
  },

  onProductChange(id, productId) {
    const item = this.saleItems.find(i=>i.id===id);
    if (!item) return;
    const prod = DB.get('products').find(p=>p.id===productId);
    item.productId = productId;
    if (prod) {
      const type = document.getElementById('sale-type').value;
      item.price = type === 'gros' ? prod.priceGros : prod.priceDetail;
      item.cost = prod.cost;
      item.productName = prod.name;
    }
    this.renderItems();
    this.calcTotal();
  },

  onQtyChange(id, val) {
    const item = this.saleItems.find(i=>i.id===id);
    if (item) { item.qty = parseInt(val)||1; this.calcTotal(); }
  },

  onPriceChange(id, val) {
    const item = this.saleItems.find(i=>i.id===id);
    if (item) { item.price = parseFloat(val)||0; this.calcTotal(); }
  },

  updatePrices() {
    const type = document.getElementById('sale-type').value;
    const prods = DB.get('products');
    this.saleItems.forEach(item => {
      const prod = prods.find(p=>p.id===item.productId);
      if (prod) item.price = type === 'gros' ? prod.priceGros : prod.priceDetail;
    });
    this.renderItems();
    this.calcTotal();
  },

  calcTotal() {
    const discountAmt = parseFloat(document.getElementById('sale-discount').value) || 0;
    const subtotal = this.saleItems.reduce((a,i)=>a+(i.qty*i.price),0);
    const total = Math.max(0, subtotal - discountAmt);
    const profit = this.saleItems.reduce((a,i)=>a+((i.price-i.cost)*i.qty),0) - discountAmt;
    document.getElementById('sale-subtotal').textContent = Utils.fmt(subtotal);
    document.getElementById('sale-discount-val').textContent = Utils.fmt(discountAmt);
    document.getElementById('sale-total').textContent = Utils.fmt(total);
    document.getElementById('sale-profit').textContent = Utils.fmt(profit);
    return {subtotal, discountAmt, total, profit};
  },

  save() {
    if (this.saleItems.some(i=>!i.productId)) {
      Toast.show('Veuillez sélectionner tous les produits', 'error');
      return;
    }
    const {total, profit} = this.calcTotal();
    const discount = parseFloat(document.getElementById('sale-discount').value) || 0; // montant fixe FCFA
    const existingId = document.getElementById('sale-id').value;
    const isEdit = !!existingId;

    const sale = {
      id: existingId || Utils.id(),
      date: document.getElementById('sale-date').value,
      client: document.getElementById('sale-client').value,
      type: document.getElementById('sale-type').value,
      items: this.saleItems.map(i=>({
        productId:i.productId, productName:i.productName||'', qty:i.qty, price:i.price, cost:i.cost
      })),
      discount,
      payment: document.getElementById('sale-payment').value,
      notes: document.getElementById('sale-notes').value,
      total,
      profit
    };

    const prods = DB.get('products');
    const hist = DB.get('stockHistory');

    if (isEdit) {
      // Restore old stock quantities before applying new ones
      const oldSale = DB.get('sales').find(s => s.id === existingId);
      if (oldSale) {
        (oldSale.items||[]).forEach(item => {
          const idx = prods.findIndex(p=>p.id===item.productId);
          if (idx >= 0) prods[idx].stock += item.qty; // restore
        });
      }
      // Apply new stock deductions
      sale.items.forEach(item => {
        const idx = prods.findIndex(p=>p.id===item.productId);
        if (idx >= 0) {
          prods[idx].stock = Math.max(0, prods[idx].stock - item.qty);
          hist.push({id:Utils.id(), date:sale.date, productId:item.productId, productName:item.productName, type:'out', qty:item.qty, note:`Modification vente #${sale.id.slice(-4)}`});
        }
      });
      DB.set('products', prods);
      DB.set('stockHistory', hist);
      // Replace sale in array
      const sales = DB.get('sales');
      const idx = sales.findIndex(s=>s.id===existingId);
      if (idx >= 0) sales[idx] = sale;
      DB.set('sales', sales);
      Toast.show('Vente modifiée avec succès');
    } else {
      // New sale — deduct stock
      sale.items.forEach(item => {
        const idx = prods.findIndex(p=>p.id===item.productId);
        if (idx >= 0) {
          prods[idx].stock = Math.max(0, prods[idx].stock - item.qty);
          hist.push({id:Utils.id(), date:sale.date, productId:item.productId, productName:item.productName, type:'out', qty:item.qty, note:`Vente #${sale.id.slice(-4)}`});
        }
      });
      DB.set('products', prods);
      DB.set('stockHistory', hist);
      const sales = DB.get('sales');
      sales.push(sale);
      DB.set('sales', sales);
      Toast.show('Vente enregistrée avec succès');
    }

    App.forceCloseModal();
    this.render();
    App.checkStockAlerts();
  },

  delete(id) {
    const sale = DB.get('sales').find(s => s.id === id);
    if (!sale) return;

    // ── Confirmation par mot de passe de suppression ──
    const s = DB.get('settings');
    const delPwd = s.deletePassword || s.password;
    const pwd = prompt('🔐 Confirmation de suppression\nEntrez le mot de passe de suppression :');
    if (pwd === null) return;
    if (pwd !== delPwd) {
      Toast.show('Mot de passe incorrect — suppression annulée', 'error');
      return;
    }

    // ── Restaurer le stock des produits ──
    const prods = DB.get('products');
    const hist  = DB.get('stockHistory');
    (sale.items || []).forEach(item => {
      const idx = prods.findIndex(p => p.id === item.productId);
      if (idx >= 0) {
        prods[idx].stock += item.qty;
        hist.push({
          id: Utils.id(),
          date: Utils.today(),
          productId:   item.productId,
          productName: item.productName,
          type: 'in',
          qty:  item.qty,
          note: `Retour/annulation vente #${sale.id.slice(-4)}`
        });
      }
    });
    DB.set('products', prods);
    DB.set('stockHistory', hist);

    // ── Déplacer vers la corbeille ──
    const trash = DB.get('deletedSales') || [];
    trash.push({ ...sale, deletedAt: new Date().toISOString() });
    DB.set('deletedSales', trash);

    // ── Supprimer la vente active ──
    DB.set('sales', DB.get('sales').filter(s => s.id !== id));
    this.render();
    App.checkStockAlerts();
    Toast.show('Vente supprimée — stock restauré — vente déplacée en corbeille', 'warning');
  },

  // ── Corbeille ventes ──
  openTrash() {
    App.openModal('trashModal');
    this.renderTrash();
  },

  renderTrash() {
    const trash = DB.get('deletedSales') || [];
    const tbody = document.getElementById('trashTbody');
    if (!tbody) return;
    if (!trash.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="empty-state-icon">🗑️</div>Corbeille vide</div></td></tr>';
      return;
    }
    tbody.innerHTML = [...trash].sort((a,b) => new Date(b.deletedAt) - new Date(a.deletedAt)).map(s => {
      const items = (s.items||[]).map(i=>`${Utils.escHtml(i.productName)} x${i.qty}`).join(', ');
      const delDate = new Date(s.deletedAt).toLocaleDateString('fr-FR');
      return `<tr>
        <td>${Utils.date(s.date)}</td>
        <td>${Utils.escHtml(s.client||'—')}</td>
        <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${Utils.escHtml(items)}">${Utils.escHtml(items)}</td>
        <td><strong>${Utils.fmt(s.total)}</strong></td>
        <td style="color:var(--text2);font-size:0.78rem">Supprimée le ${delDate}</td>
        <td>
          <button class="btn-icon" onclick="Sales.restoreFromTrash('${s.id}')" title="Restaurer cette vente">↩️</button>
          <button class="btn-icon" onclick="Sales.deleteFromTrash('${s.id}')" title="Supprimer définitivement">💀</button>
        </td>
      </tr>`;
    }).join('');
  },

  restoreFromTrash(id) {
    const trash = DB.get('deletedSales') || [];
    const sale  = trash.find(s => s.id === id);
    if (!sale) return;
    if (!confirm('Restaurer cette vente ?\nLe stock sera re-déduit automatiquement.')) return;

    // Re-déduire le stock
    const prods = DB.get('products');
    const hist  = DB.get('stockHistory');
    (sale.items || []).forEach(item => {
      const idx = prods.findIndex(p => p.id === item.productId);
      if (idx >= 0) {
        prods[idx].stock = Math.max(0, prods[idx].stock - item.qty);
        hist.push({ id: Utils.id(), date: Utils.today(), productId: item.productId, productName: item.productName, type: 'out', qty: item.qty, note: `Restauration vente #${sale.id.slice(-4)}` });
      }
    });
    DB.set('products', prods);
    DB.set('stockHistory', hist);

    // Remettre dans les ventes actives
    const { deletedAt, ...cleanSale } = sale;
    const sales = DB.get('sales');
    sales.push(cleanSale);
    DB.set('sales', sales);
    DB.set('deletedSales', trash.filter(s => s.id !== id));
    this.renderTrash();
    App.checkStockAlerts();
    Toast.show('Vente restaurée avec succès !');
  },

  deleteFromTrash(id) {
    const s2 = DB.get('settings');
    const delPwd2 = s2.deletePassword || s2.password;
    const pwd = prompt('💀 Suppression définitive — irréversible !\nMot de passe de suppression :');
    if (pwd === null) return;
    if (pwd !== delPwd2) { Toast.show('Mot de passe incorrect', 'error'); return; }
    DB.set('deletedSales', (DB.get('deletedSales') || []).filter(s => s.id !== id));
    this.renderTrash();
    Toast.show('Supprimé définitivement');
  },

  printInvoice(id) {
    App.showPage('invoices');
    setTimeout(() => Invoices.openModal(id), 100);
  },

  exportExcel() {
    const sales = DB.get('sales');
    const ws = XLSX.utils.json_to_sheet(sales.map(s=>({
      Date: s.date, Client: s.client||'—', Type: s.type,
      Total: s.total, Remise: s.discount+'%', Paiement: s.payment, Bénéfice: s.profit
    })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ventes');
    XLSX.writeFile(wb, 'ventes.xlsx');
  }
};

// ========== CLIENTS ==========
// ========== EXPENSES ==========
const Expenses = {
  render() { this.filter(); },

  filter() {
    const from = document.getElementById('expDateFrom').value;
    const to = document.getElementById('expDateTo').value;
    const cat = document.getElementById('expCatFilter').value;
    let exps = DB.get('expenses').filter(e => {
      if (!Utils.dateInRange(e.date, from, to)) return false;
      if (cat && e.category !== cat) return false;
      return true;
    });
    this.renderTable(exps);
    this.renderKPIs();
  },

  renderTable(exps) {
    const tbody = document.getElementById('expensesTbody');
    if (!exps.length) {
      tbody.innerHTML = `<tr><td colspan="5"><div class="empty-state"><div class="empty-state-icon">💸</div>Aucune dépense</div></td></tr>`;
      return;
    }
    tbody.innerHTML = [...exps].sort((a,b)=>new Date(b.date)-new Date(a.date)).map(e=>`<tr>
      <td>${Utils.date(e.date)}</td>
      <td>${Utils.escHtml(e.description)}</td>
      <td><span class="badge-info">${Utils.escHtml(e.category)}</span></td>
      <td><strong style="color:var(--danger)">${Utils.fmt(e.amount)}</strong></td>
      <td>
        <button class="btn-icon" onclick="Expenses.openModal('${e.id}')" title="Modifier">✏️</button>
        <button class="btn-icon" onclick="Expenses.delete('${e.id}')" title="Supprimer">🗑️</button>
      </td>
    </tr>`).join('');
  },

  renderKPIs() {
    const exps = DB.get('expenses');
    const total = exps.reduce((a,e)=>a+(e.amount||0),0);
    const now = new Date();
    const monthExp = exps.filter(e=>{
      const d=new Date(e.date);
      return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();
    }).reduce((a,e)=>a+(e.amount||0),0);
    document.getElementById('exp-total').textContent = Utils.fmt(total);
    document.getElementById('exp-month').textContent = Utils.fmt(monthExp);
  },

  openModal(id) {
    document.getElementById('exp-id').value = '';
    document.getElementById('exp-date').value = Utils.today();
    document.getElementById('exp-category').value = 'Loyer';
    document.getElementById('exp-desc').value = '';
    document.getElementById('exp-amount').value = '';
    if (id) {
      const e = DB.get('expenses').find(x=>x.id===id);
      if (!e) return;
      document.getElementById('exp-id').value = e.id;
      document.getElementById('exp-date').value = e.date;
      document.getElementById('exp-category').value = e.category;
      document.getElementById('exp-desc').value = e.description;
      document.getElementById('exp-amount').value = e.amount;
    }
    App.openModal('expenseModal');
  },

  save() {
    const desc = document.getElementById('exp-desc').value.trim();
    const amount = parseFloat(document.getElementById('exp-amount').value);
    if (!desc || !amount) { Toast.show('Description et montant requis', 'error'); return; }
    const id = document.getElementById('exp-id').value;
    const exp = {
      id: id||Utils.id(),
      date: document.getElementById('exp-date').value,
      category: document.getElementById('exp-category').value,
      description: desc, amount
    };
    const exps = DB.get('expenses');
    if (id) { const idx=exps.findIndex(e=>e.id===id); if(idx>=0) exps[idx]=exp; }
    else exps.push(exp);
    DB.set('expenses', exps);
    App.forceCloseModal();
    this.render();
    Toast.show(id?'Dépense modifiée':'Dépense enregistrée');
  },

  delete(id) {
    if (!confirm('Supprimer cette dépense ?')) return;
    DB.set('expenses', DB.get('expenses').filter(e=>e.id!==id));
    this.render();
    Toast.show('Dépense supprimée', 'warning');
  }
};

// ========== INVOICES ==========
const Invoices = {
  lines: [],
  logoB64: '',
  photos: [],
  colorAccent: '#c8a4a5',
  colorDark:   '#26161a',

  /* ─────────────────── ONGLET LISTE ─────────────────── */

  render() { this.renderTable(); this._updateStats(); },

  renderTable(filter) {
    let invs = DB.get('invoices').slice().reverse();
    if (filter) {
      const q = filter.toLowerCase();
      invs = invs.filter(x =>
        (x.number||'').toLowerCase().includes(q) ||
        (x.client||'').toLowerCase().includes(q)
      );
    }
    const tbody = document.getElementById('invoicesTbody');
    if (!invs.length) {
      tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:2rem">
        <div style="font-size:2rem;margin-bottom:0.5rem">🧾</div>
        Aucune facture. Cliquez "+ Nouvelle facture" pour commencer.
      </td></tr>`;
      return;
    }
    tbody.innerHTML = invs.map(inv => {
      const statusLabel = { paid:'Paye', partial:'Partiel', unpaid:'Impaye' }[inv.status] || 'Paye';
      const statusClass = { paid:'badge-success', partial:'badge-warning', unpaid:'badge-danger' }[inv.status] || 'badge-success';
      const ht  = Math.round((inv.subtotal || inv.total) * 100) / 100;
      const tva = Math.round((inv.taxAmt || 0) * 100) / 100;
      const rem = Math.round((inv.discAmt || 0) * 100) / 100;
      const ttc = Math.round((inv.total || 0) * 100) / 100;
      return `<tr>
        <td><strong style="color:var(--accent)">${this._esc(inv.number)}</strong></td>
        <td>${this._d(inv.date)}</td>
        <td>${this._esc(inv.client || '—')}</td>
        <td style="font-size:0.8rem;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${this._esc(inv.items || '—')}</td>
        <td style="text-align:right">${Utils.fmt(ht)}</td>
        <td style="text-align:right;color:var(--danger)">${rem ? '- ' + Utils.fmt(rem) : '—'}</td>
        <td style="text-align:right">${tva ? Utils.fmt(tva) : '—'}</td>
        <td style="text-align:right;font-weight:700;color:var(--accent)">${Utils.fmt(ttc)}</td>
        <td>${this._esc(inv.payment || '—')}</td>
        <td><span class="${statusClass}">${statusLabel}</span></td>
        <td>
          <button class="btn-icon" onclick="Invoices.reopen('${inv.id}')" title="Modifier">✏️</button>
          <button class="btn-icon" onclick="Invoices.doPrint('${inv.id}')" title="Imprimer">🖨️</button>
          <button class="btn-icon" onclick="Invoices.deleteInv('${inv.id}')" title="Supprimer">🗑️</button>
        </td>
      </tr>`;
    }).join('');
  },

  _updateStats() {
    const invs = DB.get('invoices');
    const now = new Date();
    const thisMonth = invs.filter(x => {
      const d = new Date(x.date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    document.getElementById('inv-stat-count').textContent  = invs.length;
    document.getElementById('inv-stat-total').textContent  = Utils.fmt(invs.reduce((a,x)=>a+(x.total||0),0));
    document.getElementById('inv-stat-month').textContent  = Utils.fmt(thisMonth.reduce((a,x)=>a+(x.total||0),0));
  },

  filterTable() {
    const q    = (document.getElementById('inv-search')?.value || '').toLowerCase();
    const from = document.getElementById('inv-filter-from')?.value || '';
    const to   = document.getElementById('inv-filter-to')?.value   || '';
    let invs = DB.get('invoices').slice().reverse();
    if (q)    invs = invs.filter(x => (x.number+x.client+'').toLowerCase().includes(q));
    if (from) invs = invs.filter(x => x.date >= from);
    if (to)   invs = invs.filter(x => x.date <= to);
    this._renderFiltered(invs);
  },

  _renderFiltered(invs) {
    const tbody = document.getElementById('invoicesTbody');
    if (!invs.length) { tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:1.5rem;color:var(--text2)">Aucun résultat</td></tr>`; return; }
    tbody.innerHTML = invs.map(inv => {
      const statusLabel = { paid:'Paye', partial:'Partiel', unpaid:'Impaye' }[inv.status] || 'Paye';
      const statusClass = { paid:'badge-success', partial:'badge-warning', unpaid:'badge-danger' }[inv.status] || 'badge-success';
      return `<tr>
        <td><strong style="color:var(--accent)">${this._esc(inv.number)}</strong></td>
        <td>${this._d(inv.date)}</td>
        <td>${this._esc(inv.client||'—')}</td>
        <td style="font-size:0.8rem">${this._esc(inv.items||'—')}</td>
        <td style="text-align:right">${Utils.fmt(inv.subtotal||inv.total)}</td>
        <td style="text-align:right;color:var(--danger)">${inv.discAmt?'- '+Utils.fmt(inv.discAmt):'—'}</td>
        <td style="text-align:right">${inv.taxAmt?Utils.fmt(inv.taxAmt):'—'}</td>
        <td style="text-align:right;font-weight:700;color:var(--accent)">${Utils.fmt(inv.total)}</td>
        <td>${this._esc(inv.payment||'—')}</td>
        <td><span class="${statusClass}">${statusLabel}</span></td>
        <td>
          <button class="btn-icon" onclick="Invoices.reopen('${inv.id}')">✏️</button>
          <button class="btn-icon" onclick="Invoices.doPrint('${inv.id}')">🖨️</button>
          <button class="btn-icon" onclick="Invoices.deleteInv('${inv.id}')">🗑️</button>
        </td>
      </tr>`;
    }).join('');
  },

  deleteInv(id) {
    if (!confirm('Supprimer cette facture ?')) return;
    let invs = DB.get('invoices').filter(x => x.id !== id);
    DB.set('invoices', invs);
    this.render();
    Toast.show('Facture supprimée', 'warning');
  },

  exportExcel() {
    const invs = DB.get('invoices');
    if (!invs.length) { Toast.show('Aucune facture à exporter', 'warning'); return; }
    const rows = [['N° Facture','Date','Client','Articles','Sous-total','Remise','TVA','Total TTC','Paiement','Statut']];
    invs.forEach(x => rows.push([
      x.number, x.date, x.client||'', x.items||'',
      x.subtotal||x.total, x.discAmt||0, x.taxAmt||0, x.total,
      x.payment||'', { paid:'Paye', partial:'Partiel', unpaid:'Impaye' }[x.status]||'Paye'
    ]));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Factures');
    XLSX.writeFile(wb, `factures_${Utils.today()}.xlsx`);
    Toast.show('Export Excel téléchargé');
  },

  /* ─────────────────── MODAL EDITEUR ─────────────────── */

  populateSaleSelect() {
    const sales = DB.get('sales').slice(-100).reverse();
    const sel = document.getElementById('inv-sale-ref');
    if (!sel) return;
    sel.innerHTML = '<option value="">-- Lier a une vente --</option>' +
      sales.map(s => `<option value="${s.id}">${this._d(s.date)} - ${this._esc(s.client||'Client')} - ${Utils.fmt(s.total)}</option>`).join('');
  },

  openModal(saleId) {
    const s = DB.get('settings');
    this.logoB64 = s.logoBase64 || '';
    this.photos  = [];
    this.colorAccent = '#c8a4a5';
    this.colorDark   = '#26161a';
    this.lines   = [{ desc:'', qty:1, price:0 }];

    /* Boutique */
    this._v('inv-shop-name',    s.shopName || '');
    this._v('inv-shop-address', s.address  || '');
    this._v('inv-shop-phone',   s.phone    || '');
    this._v('inv-shop-email',   s.email    || '');
    this._v('inv-shop-web',     s.website  || '');
    this._v('inv-shop-ninea',   s.ninea    || '');

    /* Client */
    this._v('inv-client',       '');
    this._v('inv-client-addr',  '');
    this._v('inv-client-phone', '');
    this._v('inv-client-email', '');

    /* Facture */
    const invs = DB.get('invoices');
    this._v('inv-number',  'FAC-' + String(invs.length + 1).padStart(4,'0'));
    this._v('inv-date',    Utils.today());
    this._v('inv-due',     '');
    this._v('inv-sale-type', '');
    this._v('inv-payment', 'Especes');
    this._v('inv-status',  'paid');
    this._v('inv-advance-paid', '0');
    this._v('inv-discount', '0');
    this._v('inv-tax',      '0');
    this._v('inv-notes',    'Merci pour votre confiance !');
    this._v('inv-terms',    '');
    this._v('inv-warranty-duration', '');
    this._v('inv-warranty-text', '');

    /* Checkboxes */
    const setChk = (id, v) => { const el = document.getElementById(id); if(el) el.checked = v; };
    setChk('inv-show-warranty', false);
    setChk('inv-show-photo', false);
    const wb = document.getElementById('inv-warranty-block');
    const pb = document.getElementById('inv-photo-block');
    const pp = document.getElementById('inv-photo-previews');
    const ap = document.getElementById('inv-partial-block');
    if(wb) wb.style.display = 'none';
    if(pb) pb.style.display = 'none';
    if(pp) pp.innerHTML = '';
    if(ap) ap.style.display = 'none';

    this._refreshLogoUI();
    this._refreshClientDatalist();
    this.populateSaleSelect();

    if (saleId) {
      const sale = DB.get('sales').find(x => x.id === saleId);
      if (sale) this._fillSale(sale);
    }

    this.renderLines();
    this.preview();
    App.openModal('invoiceModal');
  },

  fillFromSale(id) {
    if (!id) return;
    const sale = DB.get('sales').find(s => s.id === id);
    if (!sale) return;
    this._fillSale(sale);
    this.renderLines();
    this.preview();
  },

  _fillSale(sale) {
    this._v('inv-client',   sale.client || '');
    this._v('inv-discount', sale.discount || 0);
    this._v('inv-payment',  sale.payment || 'Especes');
    this._v('inv-notes',    sale.notes || 'Merci pour votre confiance !');
    this._v('inv-sale-type', sale.type || '');
    const cli = null;
    if (cli) {
      this._v('inv-client-addr',  cli.address || '');
      this._v('inv-client-phone', cli.phone   || '');
    }
    this.lines = (sale.items||[]).map(i => ({ desc: i.productName||'', qty: i.qty||1, price: i.price||0 }));
    if (!this.lines.length) this.lines = [{ desc:'', qty:1, price:0 }];
  },

  onClientChange() {
    const name = this._g('inv-client');
    const cli = null;
    if (cli) {
      this._v('inv-client-addr',  cli.address || '');
      this._v('inv-client-phone', cli.phone   || '');
    }
    this.preview();
  },

  onStatusChange() {
    const st = this._g('inv-status');
    const ap = document.getElementById('inv-partial-block');
    if (ap) ap.style.display = st === 'partial' ? '' : 'none';
    this.preview();
  },

  /* Lines */
  addLine() {
    this.lines.push({ desc:'', qty:1, price:0 });
    this.renderLines();
    this.preview();
  },

  removeLine(i) {
    if (this.lines.length === 1) return;
    this.lines.splice(i, 1);
    this.renderLines();
    this.preview();
  },

  updateLine(i, field, val) {
    if (!this.lines[i]) return;
    this.lines[i][field] = field === 'desc' ? val : (parseFloat(val) || 0);
    this.preview();
  },

  renderLines() {
    const c = document.getElementById('inv-items-list');
    if (!c) return;
    c.innerHTML = this.lines.map((l, i) => `
      <div class="inv-line-row">
        <input class="inv-line-desc" type="text" value="${this._esc(l.desc)}" placeholder="Article..." oninput="Invoices.updateLine(${i},'desc',this.value)">
        <input class="inv-line-qty" type="number" value="${l.qty}" min="1" oninput="Invoices.updateLine(${i},'qty',this.value)">
        <input class="inv-line-price" type="number" value="${l.price}" min="0" placeholder="Prix" oninput="Invoices.updateLine(${i},'price',this.value)">
        <button class="inv-line-del" onclick="Invoices.removeLine(${i})">✕</button>
      </div>`).join('');
  },

  /* Logo & photos */
  handleLogo(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 3*1024*1024) { Toast.show('Logo max 3MB', 'error'); return; }
    const r = new FileReader();
    r.onload = e => { this.logoB64 = e.target.result; this._refreshLogoUI(); this.preview(); };
    r.readAsDataURL(file);
  },

  removeLogo() {
    this.logoB64 = '';
    this._refreshLogoUI();
    this.preview();
  },

  _refreshLogoUI() {
    const prev = document.getElementById('inv-logo-preview');
    const ph   = document.getElementById('inv-logo-placeholder');
    if (!prev) return;
    if (this.logoB64) {
      prev.src = this.logoB64; prev.style.display = 'block';
      if (ph) ph.style.display = 'none';
    } else {
      prev.src = ''; prev.style.display = 'none';
      if (ph) ph.style.display = '';
    }
  },

  handlePhotos(input) {
    const files = Array.from(input.files).slice(0, 2);
    this.photos = [];
    let done = 0;
    if (!files.length) return;
    files.forEach(file => {
      const r = new FileReader();
      r.onload = e => {
        this.photos.push(e.target.result);
        if (++done === files.length) { this._refreshPhotoUI(); this.preview(); }
      };
      r.readAsDataURL(file);
    });
  },

  _refreshPhotoUI() {
    const c = document.getElementById('inv-photo-previews');
    if (!c) return;
    c.innerHTML = this.photos.map((p, i) =>
      `<div style="position:relative;display:inline-block">
        <img src="${p}" style="height:54px;border-radius:5px;object-fit:cover">
        <button onclick="Invoices.removePhoto(${i})" style="position:absolute;top:-4px;right:-4px;background:#c0392b;color:#fff;border:none;border-radius:50%;width:16px;height:16px;cursor:pointer;font-size:0.6rem;line-height:16px">x</button>
      </div>`).join('');
  },

  removePhoto(i) { this.photos.splice(i,1); this._refreshPhotoUI(); this.preview(); },

  togglePhotoSection() {
    const show = document.getElementById('inv-show-photo')?.checked;
    const pb = document.getElementById('inv-photo-block');
    if (pb) pb.style.display = show ? '' : 'none';
    this.preview();
  },

  setColor(accent, dark) { this.colorAccent = accent; this.colorDark = dark; this.preview(); },

  _toggleWarranty() {
    const show = document.getElementById('inv-show-warranty')?.checked;
    const wb = document.getElementById('inv-warranty-block');
    if (wb) wb.style.display = show ? '' : 'none';
    this.preview();
  },

  _refreshClientDatalist() {
    const dl = document.getElementById('clientNames2');
    if (dl) dl.innerHTML = '';
  },

  /* ─── helpers ─── */
  _v(id, val)   { const el = document.getElementById(id); if(el) el.value = String(val); },
  _g(id)        { const el = document.getElementById(id); return el ? el.value.trim() : ''; },
  _chk(id)      { const el = document.getElementById(id); return el ? el.checked : false; },
  _esc(s)       { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); },
  _d(dateStr)   { if(!dateStr) return ''; const p=dateStr.split('-'); return p.length===3?`${p[2]}/${p[1]}/${p[0]}`:dateStr; },
  _money(n)     {
    const num = Math.round(n || 0);
    let s = '';
    let str = String(num);
    for (let i = 0; i < str.length; i++) {
      if (i > 0 && (str.length - i) % 3 === 0) s += ' ';
      s += str[i];
    }
    return s + ' FCFA';
  },

  /* ─────────────────── GENERATEUR HTML FACTURE A5 ─────────────────── */

  _buildInvoiceHTML() {
    /* Collecte des valeurs */
    const shopName  = this._g('inv-shop-name')    || 'Ma Boutique';
    const shopAddr  = this._g('inv-shop-address');
    const shopPhone = this._g('inv-shop-phone');
    const shopEmail = this._g('inv-shop-email');
    const shopWeb   = this._g('inv-shop-web');
    const shopNinea = this._g('inv-shop-ninea');

    const cliName  = this._g('inv-client')       || 'Client';
    const cliAddr  = this._g('inv-client-addr');
    const cliPhone = this._g('inv-client-phone');
    const cliEmail = this._g('inv-client-email');

    const invNum   = this._g('inv-number')       || 'FAC-0001';
    const invDate  = this._g('inv-date');
    const invDue   = this._g('inv-due');
    const saleType = this._g('inv-sale-type');
    const payment  = this._g('inv-payment');
    const status   = this._g('inv-status') || 'paid';
    const advPaid  = parseFloat(this._g('inv-advance-paid')) || 0;

    const discPct  = parseFloat(this._g('inv-discount')) || 0;
    const taxPct   = parseFloat(this._g('inv-tax'))      || 0;
    const notes    = this._g('inv-notes');
    const terms    = this._g('inv-terms');

    const showWarr  = this._chk('inv-show-warranty');
    const warrDur   = this._g('inv-warranty-duration');
    const warrTxt   = this._g('inv-warranty-text');
    const showPhoto = this._chk('inv-show-photo');

    const A = this.colorAccent;
    const D = this.colorDark;

    /* Calculs */
    const subtotal = this.lines.reduce((acc,l) => acc + l.qty * l.price, 0);
    const discAmt  = subtotal * discPct / 100;
    const afterDisc= subtotal - discAmt;
    const taxAmt   = afterDisc * taxPct / 100;
    const total    = afterDisc + taxAmt;
    const restant  = status === 'partial' ? Math.max(0, total - advPaid) : 0;

    /* Logo block */
    const logoBlock = this.logoB64
      ? `<img src="${this.logoB64}" style="max-height:55px;max-width:130px;object-fit:contain;display:block">`
      : `<div style="width:50px;height:50px;background:${A};border-radius:8px;display:table-cell;vertical-align:middle;text-align:center;font-size:22px;font-weight:900;color:#fff">${shopName.charAt(0).toUpperCase()}</div>`;

    /* Lignes boutique */
    const shopLines = [shopAddr, shopPhone, shopEmail, shopWeb, shopNinea ? ('NINEA: '+shopNinea) : ''].filter(Boolean);
    const shopInfoHtml = shopLines.map(l => `<div style="font-size:9.5px;color:rgba(255,255,255,0.72);line-height:1.85">${this._esc(l)}</div>`).join('');
    const shopBlock2   = shopLines.map(l => `<div style="font-size:9px;color:#555;line-height:1.8">${this._esc(l)}</div>`).join('');

    /* Lignes client */
    const cliLines = [cliAddr, cliPhone, cliEmail].filter(Boolean);
    const cliBlock = cliLines.map(l => `<div style="font-size:9px;color:rgba(255,255,255,0.65);line-height:1.8">${this._esc(l)}</div>`).join('');

    /* Tableau articles */
    const rowsHtml = this.lines.map((l, i) => {
      const mt = l.qty * l.price;
      const bg = i % 2 === 0 ? '#fdf6f4' : '#fff';
      return `<tr style="background:${bg}">
        <td style="padding:7px 10px;border-bottom:1px solid #ede4e0;font-size:10px;font-weight:600;color:#111">${this._esc(l.desc)||'—'}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #ede4e0;font-size:10px;text-align:center;color:#444">${l.qty}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #ede4e0;font-size:10px;text-align:right;color:#444;white-space:nowrap">${this._money(l.price)}</td>
        <td style="padding:7px 10px;border-bottom:1px solid #ede4e0;font-size:10px;text-align:right;font-weight:700;color:${A};white-space:nowrap">${this._money(mt)}</td>
      </tr>`;
    }).join('');

    /* Totaux */
    let totHtml = `
      <tr><td colspan="3" style="padding:5px 10px;text-align:right;font-size:9px;color:#777">Sous-total HT</td>
          <td style="padding:5px 10px;text-align:right;font-size:9px;color:#333;white-space:nowrap">${this._money(subtotal)}</td></tr>`;
    if (discPct > 0) totHtml += `
      <tr><td colspan="3" style="padding:3px 10px;text-align:right;font-size:9px;color:#c0392b">Remise (${discPct}%)</td>
          <td style="padding:3px 10px;text-align:right;font-size:9px;color:#c0392b;white-space:nowrap">- ${this._money(discAmt)}</td></tr>`;
    if (taxPct > 0) totHtml += `
      <tr><td colspan="3" style="padding:3px 10px;text-align:right;font-size:9px;color:#555">TVA (${taxPct}%)</td>
          <td style="padding:3px 10px;text-align:right;font-size:9px;color:#333;white-space:nowrap">+ ${this._money(taxAmt)}</td></tr>`;
    totHtml += `
      <tr><td colspan="4" style="padding:3px 10px"><div style="height:2px;background:${A};border-radius:2px"></div></td></tr>
      <tr style="background:${D}">
        <td colspan="2" style="padding:10px"></td>
        <td style="padding:10px;text-align:right;color:rgba(255,255,255,0.65);font-size:9px;text-transform:uppercase;letter-spacing:1px;vertical-align:middle">TOTAL TTC</td>
        <td style="padding:10px;text-align:right;font-size:15px;font-weight:900;color:#fff;white-space:nowrap;vertical-align:middle">${this._money(total)}</td>
      </tr>`;
    if (status === 'partial' && advPaid > 0) {
      totHtml += `
        <tr><td colspan="3" style="padding:4px 10px;text-align:right;font-size:9px;color:#2e7d32">Avance versee</td>
            <td style="padding:4px 10px;text-align:right;font-size:9px;color:#2e7d32;white-space:nowrap">${this._money(advPaid)}</td></tr>
        <tr><td colspan="3" style="padding:4px 10px;text-align:right;font-size:10px;font-weight:700;color:#c0392b">Reste a payer</td>
            <td style="padding:4px 10px;text-align:right;font-size:10px;font-weight:700;color:#c0392b;white-space:nowrap">${this._money(restant)}</td></tr>`;
    }

    /* Badge statut */
    const statusColor = { paid:'#2e7d32', partial:'#e65100', unpaid:'#c0392b' }[status] || '#2e7d32';
    const statusText  = { paid:'PAYE', partial:'PARTIELLEMENT PAYE', unpaid:'NON PAYE' }[status] || 'PAYE';

    /* Type vente */
    const typeLabel = { detail:'Vente au detail', gros:'Vente en gros' }[saleType] || '';

    /* Meta bar items */
    const metaItems = [
      payment && `<span><strong style="color:${A}">Paiement:</strong> ${this._esc(payment)}</span>`,
      invDate && `<span><strong style="color:${A}">Date:</strong> ${this._d(invDate)}</span>`,
      invDue  && `<span><strong style="color:${A}">Echeance:</strong> ${this._d(invDue)}</span>`,
      typeLabel && `<span><strong style="color:${A}">Type:</strong> ${this._esc(typeLabel)}</span>`,
    ].filter(Boolean).join('<span style="color:#ccc;margin:0 6px">|</span>');

    /* Photos */
    const photoHtml = (showPhoto && this.photos.length) ? `
      <div style="padding:10px 22px 0">
        <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:${A};margin-bottom:6px">Photos</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${this.photos.map(p=>`<img src="${p}" style="height:75px;width:75px;object-fit:cover;border-radius:6px;border:2px solid ${A}">`).join('')}
        </div>
      </div>` : '';

    /* Garantie */
    const warrHtml = (showWarr && (warrDur||warrTxt)) ? `
      <div style="margin:10px 22px 0;padding:8px 12px;background:#fffbf0;border-left:3px solid #e6a817;border-radius:4px">
        <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#b07000;margin-bottom:3px">Garantie${warrDur?' - '+this._esc(warrDur):''}</div>
        ${warrTxt?`<div style="font-size:8.5px;color:#5a4000;line-height:1.5">${this._esc(warrTxt)}</div>`:''}
      </div>` : '';

    /* Notes */
    const notesHtml = notes ? `
      <div style="margin:10px 22px 0;padding:8px 12px;background:#f0faf5;border-left:3px solid #4caf50;border-radius:4px">
        <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#2e7d32;margin-bottom:3px">Note</div>
        <div style="font-size:8.5px;color:#1a4a2a;line-height:1.5">${this._esc(notes)}</div>
      </div>` : '';

    /* Conditions */
    const termsHtml = terms ? `
      <div style="margin:8px 22px 0;padding:8px 12px;background:#f5f5f5;border-left:3px solid #aaa;border-radius:4px">
        <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#555;margin-bottom:3px">Conditions generales</div>
        <div style="font-size:8px;color:#444;line-height:1.5">${this._esc(terms)}</div>
      </div>` : '';

    /* Contact footer */
    const footContact = [shopPhone, shopEmail, shopWeb].filter(Boolean).join('   |   ');

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<title>Facture ${this._esc(invNum)}</title>
<style>
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:Arial,Helvetica,sans-serif; background:#fff; color:#111; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
table { border-collapse:collapse; }
@page { size:A5 portrait; margin:0; }
@media print { html,body { width:148mm; height:210mm; } }
</style>
</head>
<body>
<div style="width:559px;min-height:794px;background:#fff;position:relative">

  <!-- EN-TETE COLORE -->
  <div style="background:${D};padding:20px 22px 16px;position:relative;overflow:hidden">
    <div style="position:absolute;top:-35px;right:-35px;width:140px;height:140px;border-radius:50%;background:${A};opacity:0.15"></div>
    <table width="100%" style="border-collapse:collapse">
      <tr>
        <td style="vertical-align:middle;width:55%">
          <table style="border-collapse:collapse">
            <tr>
              <td style="vertical-align:middle;padding-right:12px">${logoBlock}</td>
              <td style="vertical-align:middle">
                <div style="font-size:16px;font-weight:900;color:#fff;letter-spacing:0.5px;margin-bottom:3px">${this._esc(shopName)}</div>
                ${shopInfoHtml}
              </td>
            </tr>
          </table>
        </td>
        <td style="vertical-align:top;text-align:right;width:45%">
          <div style="background:${A};display:inline-block;padding:4px 16px;border-radius:20px;margin-bottom:8px">
            <span style="font-size:13px;font-weight:900;color:#fff;letter-spacing:2px">FACTURE</span>
          </div>
          <div style="color:#fff;font-size:13px;font-weight:700;margin-bottom:2px">${this._esc(invNum)}</div>
          <div style="color:rgba(255,255,255,0.6);font-size:9px">Emise le ${this._d(invDate)}</div>
          ${invDue ? `<div style="color:rgba(255,255,255,0.5);font-size:9px">Echeance: ${this._d(invDue)}</div>` : ''}
          <div style="margin-top:6px;background:${statusColor};display:inline-block;padding:2px 10px;border-radius:20px">
            <span style="font-size:8px;font-weight:700;color:#fff;letter-spacing:1px">${statusText}</span>
          </div>
        </td>
      </tr>
    </table>
  </div>

  <!-- BANDE DEGRADE -->
  <div style="height:4px;background:linear-gradient(90deg,${A},${D},${A})"></div>

  <!-- BLOCS DE / FACTURE A -->
  <div style="padding:14px 22px 10px">
    <table width="100%" style="border-collapse:collapse">
      <tr>
        <td style="width:47%;vertical-align:top;padding-right:8px">
          <div style="background:#f7f2f0;border-radius:8px;padding:10px 12px;border-left:3px solid ${A}">
            <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:${A};margin-bottom:5px">Emetteur</div>
            <div style="font-size:11px;font-weight:700;color:#111;margin-bottom:3px">${this._esc(shopName)}</div>
            ${shopBlock2}
          </div>
        </td>
        <td style="width:6%"></td>
        <td style="width:47%;vertical-align:top;padding-left:8px">
          <div style="background:${D};border-radius:8px;padding:10px 12px">
            <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:${A};margin-bottom:5px">Facture a</div>
            <div style="font-size:11px;font-weight:700;color:#fff;margin-bottom:3px">${this._esc(cliName)}</div>
            ${cliBlock}
          </div>
        </td>
      </tr>
    </table>
  </div>

  <!-- META BAR -->
  ${metaItems ? `<div style="margin:0 22px 10px;background:#f4efed;border-radius:6px;padding:7px 12px;font-size:9px;color:#444;display:flex;gap:0;flex-wrap:wrap;line-height:1.8">${metaItems}</div>` : ''}

  <!-- TABLEAU ARTICLES -->
  <div style="padding:0 22px">
    <table width="100%" style="border-collapse:collapse;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:${D}">
          <th style="padding:8px 10px;text-align:left;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:1px;font-weight:700">Designation</th>
          <th style="padding:8px 10px;text-align:center;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:1px;font-weight:700;width:40px">Qte</th>
          <th style="padding:8px 10px;text-align:right;color:#fff;font-size:9px;text-transform:uppercase;letter-spacing:1px;font-weight:700;width:105px">Prix unit.</th>
          <th style="padding:8px 10px;text-align:right;color:${A};font-size:9px;text-transform:uppercase;letter-spacing:1px;font-weight:700;width:105px">Montant</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
      <tfoot>${totHtml}</tfoot>
    </table>
  </div>

  ${photoHtml}
  ${notesHtml}
  ${warrHtml}
  ${termsHtml}

  <!-- PIED DE PAGE -->
  <div style="margin-top:16px;padding:12px 22px 18px;border-top:1px solid #e0d8d4">
    <table width="100%" style="border-collapse:collapse">
      <tr>
        <td style="vertical-align:middle">
          <div style="font-size:11px;font-weight:700;color:${A}">Merci pour votre confiance !</div>
          ${footContact ? `<div style="font-size:8.5px;color:#999;margin-top:2px">${this._esc(footContact)}</div>` : ''}
        </td>
        <td style="text-align:right;vertical-align:middle">
          <div style="font-size:8px;color:#bbb">${this._esc(invNum)} — ${this._d(invDate)}</div>
          <div style="font-size:7.5px;color:#ccc;margin-top:1px">Document genere par Boutique Manager Pro</div>
        </td>
      </tr>
    </table>
  </div>

</div>
</body>
</html>`;
  },

  /* ─────────────────── APERCU LIVE ─────────────────── */

  preview() {
    const c = document.getElementById('invoicePreview');
    if (!c) return;
    const html = this._buildInvoiceHTML();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    c.innerHTML = doc.body.innerHTML;
  },

  /* ─────────────────── IMPRESSION & TÉLÉCHARGEMENT PDF ─────────────────── */

  // Impression physique — ouvre une popup
  printDirect() {
    this.preview();
    this._saveRecord();
    const html = this._buildInvoiceHTML();
    const win = window.open('', '_blank', 'width=720,height=680');
    if (!win) { Toast.show('Autorisez les popups du navigateur', 'error'); return; }
    win.document.write(html);
    win.document.close();
    const doPrint = () => { win.focus(); win.print(); };
    win.onload = doPrint;
    setTimeout(doPrint, 900);
    Toast.show('Fenêtre d\'impression ouverte');
  },

  // Téléchargement PDF direct — sans imprimante
  downloadPDF() {
    this.preview();
    this._saveRecord();

    const invNum  = this._g('inv-number')  || 'facture';
    const cliName = this._g('inv-client')  || 'client';
    const fileName = ('Facture_' + invNum + '_' + cliName).replace(/[^\w\-]/g, '_') + '.pdf';

    // Méthode 1 : html2pdf.js (chargé depuis CDN)
    if (typeof html2pdf !== 'undefined') {
      const htmlStr = this._buildInvoiceHTML();
      const parser  = new DOMParser();
      const doc     = parser.parseFromString(htmlStr, 'text/html');

      // Wrapper temporaire invisible
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;left:-9999px;top:0;width:794px;background:#fff;z-index:-1;font-size:12px';
      wrap.innerHTML = doc.body.innerHTML;
      document.body.appendChild(wrap);

      const opt = {
        margin:      [5, 5, 5, 5],
        filename:    fileName,
        image:       { type: 'jpeg', quality: 0.97 },
        html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: '#fff' },
        jsPDF:       { unit: 'mm', format: 'a5', orientation: 'portrait' }
      };

      Toast.show('⏳ Génération du PDF...');
      html2pdf().set(opt).from(wrap).save()
        .then(() => {
          document.body.removeChild(wrap);
          Toast.show('✅ Facture téléchargée : ' + fileName);
        })
        .catch(err => {
          document.body.removeChild(wrap);
          console.error('[PDF]', err);
          Toast.show('Erreur PDF — essayez "Imprimer" → "Enregistrer en PDF"', 'error');
        });
      return;
    }

    // Méthode 2 : fallback popup avec instructions intégrées
    const htmlStr = this._buildInvoiceHTML();
    const withInstr = htmlStr.replace('</body>',
      `<div style="position:fixed;bottom:0;left:0;right:0;background:#26161a;color:#fff;padding:10px 18px;font-family:sans-serif;font-size:12px;text-align:center;z-index:9999">
         📥 Pour télécharger sans imprimante : <strong>Destination</strong> → <strong>Enregistrer en PDF</strong> → Enregistrer
         <button onclick="this.parentElement.remove()" style="margin-left:12px;background:#c8a4a5;border:none;color:#fff;padding:3px 10px;border-radius:4px;cursor:pointer">OK</button>
       </div>
       <script>window.onload=function(){window.print();}<\/script>
     </body>`);
    const win = window.open('', '_blank', 'width=720,height=700');
    if (!win) { Toast.show('Autorisez les popups du navigateur', 'error'); return; }
    win.document.write(withInstr);
    win.document.close();
    Toast.show('📥 Dans la boîte d\'impression → "Enregistrer en PDF"');
  },

  /* ─────────────────── SAUVEGARDE RECORD ─────────────────── */

  _saveRecord() {
    const invNum   = this._g('inv-number')  || 'FAC-0001';
    const invDate  = this._g('inv-date')    || Utils.today();
    const cliName  = this._g('inv-client')  || 'Client';
    const payment  = this._g('inv-payment');
    const status   = this._g('inv-status')  || 'paid';
    const discPct  = parseFloat(this._g('inv-discount')) || 0;
    const taxPct   = parseFloat(this._g('inv-tax'))      || 0;
    const subtotal = this.lines.reduce((a,l) => a + l.qty * l.price, 0);
    const discAmt  = subtotal * discPct / 100;
    const afterD   = subtotal - discAmt;
    const taxAmt   = afterD * taxPct / 100;
    const total    = afterD + taxAmt;
    const items    = this.lines.map(l => l.desc).filter(Boolean).join(', ');

    const invs = DB.get('invoices');
    const idx  = invs.findIndex(x => x.number === invNum);
    const rec  = { id: idx >= 0 ? invs[idx].id : Utils.id(), number: invNum, date: invDate,
                   client: cliName, payment, status, subtotal, discAmt, taxAmt, total, items };
    if (idx >= 0) invs[idx] = rec; else invs.push(rec);
    DB.set('invoices', invs);
    this.render();
  },

  /* ─────────────────── REOPEN / QUICK PRINT ─────────────────── */

  reopen(id) {
    const inv = DB.get('invoices').find(x => x.id === id);
    if (!inv) return;
    // Open modal from linked sale if exists
    const sale = DB.get('sales').find(s => s.id === inv.saleId);
    this.openModal(sale ? sale.id : null);
    // Restore invoice fields
    this._v('inv-number', inv.number);
    this._v('inv-client', inv.client || '');
    if (inv.date)    this._v('inv-date', inv.date);
    if (inv.payment) this._v('inv-payment', inv.payment);
    if (inv.status)  this._v('inv-status', inv.status);
    this.preview();
  },

  doPrint(id) {
    const inv = DB.get('invoices').find(x => x.id === id);
    if (!inv) { Toast.show('Facture introuvable', 'error'); return; }
    const sale = DB.get('sales').find(s => s.id === inv.saleId);
    this.openModal(sale ? sale.id : null);
    this._v('inv-number', inv.number);
    this._v('inv-client', inv.client || '');
    if (inv.date)    this._v('inv-date', inv.date);
    if (inv.payment) this._v('inv-payment', inv.payment);
    if (inv.status)  this._v('inv-status', inv.status);
    this.preview();
    setTimeout(() => this.printDirect(), 500);
  }
};

// ========== SETTINGS ==========
const Settings = {
  save() {
    const s = DB.get('settings');
    s.shopName  = document.getElementById('set-shopname').value.trim() || s.shopName;
    s.address   = document.getElementById('set-address').value.trim();
    s.phone     = document.getElementById('set-phone').value.trim();
    s.email     = document.getElementById('set-email').value.trim();
    s.website   = (document.getElementById('set-website')?.value || '').trim();
    s.ninea     = (document.getElementById('set-ninea')?.value || '').trim();
    s.stockThreshold = parseInt(document.getElementById('set-stock-threshold').value) || 5;
    DB.set('settings', s);
    document.getElementById('brandName').textContent = s.shopName;
    AutoBackup.onDataChange();
    Toast.show('Parametres sauvegardes');
  },

  handleLogoUpload(input) {
    const file = input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { Toast.show('Image trop lourde (max 2MB)', 'error'); return; }
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target.result;
      // Detect format
      const fmt = file.type.includes('png') ? 'PNG' : file.type.includes('gif') ? 'GIF' : 'JPEG';
      // Save to settings
      const s = DB.get('settings');
      s.logoBase64 = base64;
      s.logoFormat = fmt;
      DB.set('settings', s);
      // Show preview
      document.getElementById('logoPreview').src = base64;
      document.getElementById('logoPreview').style.display = 'block';
      document.getElementById('logoPlaceholder').style.display = 'none';
      Toast.show('Logo enregistré');
    };
    reader.readAsDataURL(file);
  },

  removeLogo() {
    const s = DB.get('settings');
    s.logoBase64 = '';
    s.logoFormat = '';
    DB.set('settings', s);
    document.getElementById('logoPreview').src = '';
    document.getElementById('logoPreview').style.display = 'none';
    document.getElementById('logoPlaceholder').style.display = '';
    Toast.show('Logo supprimé', 'warning');
  },

  loadLogoPreview() {
    const s = DB.get('settings');
    if (s.logoBase64) {
      const prev = document.getElementById('logoPreview');
      if (prev) {
        prev.src = s.logoBase64;
        prev.style.display = 'block';
        const ph = document.getElementById('logoPlaceholder');
        if (ph) ph.style.display = 'none';
      }
    }
  },

  changePass() {
    const np = document.getElementById('set-pass').value;
    if (!np || np.length < 4) { Toast.show('Mot de passe trop court (min 4 caractères)', 'error'); return; }
    const s = DB.get('settings');
    s.password = np;
    DB.set('settings', s);
    document.getElementById('set-pass').value = '';
    Toast.show('✅ Mot de passe admin changé');
  },

  changeDeletePass() {
    const np = document.getElementById('set-del-pass').value;
    if (!np || np.length < 3) { Toast.show('Mot de passe trop court (min 3 caractères)', 'error'); return; }
    const s = DB.get('settings');
    s.deletePassword = np;
    DB.set('settings', s);
    document.getElementById('set-del-pass').value = '';
    Toast.show('✅ Mot de passe de suppression changé');
  },

};



// ========== CREDITS MODULE ==========
const Credits = {
  creditItems: [],   // [{id, productId, productName, qty, price, cost}]

  render() {
    this._updateStats();
    this._renderTable();
  },

  _updateStats() {
    const credits = DB.get('credits') || [];
    const totalCredit  = credits.reduce((a,c) => a + (c.totalDue||0), 0);
    const totalReceived= credits.reduce((a,c) => a + (c.amountPaid||0), 0);
    const totalLeft    = totalCredit - totalReceived;
    const nbDebtors    = credits.filter(c => c.status !== 'paid').length;
    const set = (id,v) => { const el=document.getElementById(id); if(el) el.textContent=v; };
    set('cr-stat-clients',  nbDebtors);
    set('cr-stat-total',    Utils.fmt(totalCredit));
    set('cr-stat-received', Utils.fmt(totalReceived));
    set('cr-stat-left',     Utils.fmt(totalLeft));
    // Badge on nav
    const badge = document.getElementById('nav-credits-badge');
    if (badge) {
      badge.textContent = nbDebtors;
      badge.style.display = nbDebtors > 0 ? 'inline' : 'none';
    }
  },

  _renderTable() {
    const tbody = document.getElementById('creditsTbody');
    if (!tbody) return;
    const credits = (DB.get('credits') || []).slice().reverse();
    if (!credits.length) {
      tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text2)">Aucune vente à crédit enregistrée</td></tr>`;
      return;
    }
    tbody.innerHTML = credits.map(c => {
      const left = Math.max(0, (c.totalDue||0) - (c.amountPaid||0));
      const pct  = c.totalDue ? Math.round((c.amountPaid||0) / c.totalDue * 100) : 0;
      const isDue = c.dueDate && new Date(c.dueDate) < new Date() && c.status !== 'paid';
      const stCls = c.status === 'paid' ? 'badge-success' : isDue ? 'badge-danger' : 'badge-warning';
      const stLbl = c.status === 'paid' ? 'Soldé' : isDue ? 'En retard' : 'En attente';
      return `<tr>
        <td>${Utils.date(c.date)}</td>
        <td><strong>${Utils.escHtml(c.client)}</strong><br><small style="color:var(--text2)">${Utils.escHtml(c.phone||'')}</small></td>
        <td style="max-width:200px;font-size:0.82rem">${Utils.escHtml(c.items)}</td>
        <td>${Utils.fmt(c.totalDue)}</td>
        <td style="color:#4caf50">${Utils.fmt(c.amountPaid||0)}</td>
        <td style="color:var(--danger);font-weight:700">${Utils.fmt(left)}</td>
        <td>
          <div class="cr-progress-bar">
            <div class="cr-progress-fill" style="width:${pct}%"></div>
          </div>
          <div style="font-size:0.7rem;color:var(--text2);text-align:center">${pct}%</div>
        </td>
        <td><span class="${stCls}">${stLbl}</span></td>
        <td>
          ${c.status !== 'paid' ? `<button class="btn-icon" onclick="Credits.addPayment('${c.id}')" title="Enregistrer versement">💰</button>` : ''}
          <button class="btn-icon" onclick="Credits.openModal('${c.id}')" title="Modifier">✏️</button>
          <button class="btn-icon" onclick="Credits.delete('${c.id}')" title="Supprimer">🗑️</button>
        </td>
      </tr>`;
    }).join('');
  },

  openModal(id) {
    const isEdit = !!id;
    document.getElementById('creditModalTitle').textContent = isEdit ? 'Modifier le crédit' : 'Nouvelle vente à crédit';
    const sv = (elId,v) => { const el=document.getElementById(elId); if(el) el.value=v||''; };
    sv('cr-id',''); sv('cr-client',''); sv('cr-phone','');
    sv('cr-paid','0'); sv('cr-date', Utils.today()); sv('cr-due',''); sv('cr-notes','');
    this.creditItems = [{ id: Utils.id(), productId:'', productName:'', qty:1, price:0, cost:0 }];

    if (isEdit) {
      const c = (DB.get('credits')||[]).find(x=>x.id===id);
      if (!c) return;
      sv('cr-id', c.id); sv('cr-client', c.client); sv('cr-phone', c.phone||'');
      sv('cr-paid', c.amountPaid||0); sv('cr-date', c.date); sv('cr-due', c.dueDate||''); sv('cr-notes', c.notes||'');
      this.creditItems = (c.creditItems||[]).length > 0
        ? c.creditItems.map(i=>({...i}))
        : [{ id: Utils.id(), productId:'', productName: c.items||'', qty:1, price: c.totalDue||0, cost:0 }];
    }
    this._renderCreditItems();
    App.openModal('creditModal');
  },

  _renderCreditItems() {
    const cont = document.getElementById('cr-items-list');
    if (!cont) return;
    const prods = DB.get('products') || [];
    const type  = 'detail'; // credits always at retail
    cont.innerHTML = this.creditItems.map((item, idx) => {
      const selProd = prods.find(p => p.id === item.productId);
      const displayName = selProd ? selProd.name : (item.productName || '');
      return `<div class="sale-item-row" id="cir-${item.id}">
        <div class="prod-search-wrap">
          <input type="text"
            class="prod-search-input"
            value="${Utils.escHtml(displayName)}"
            placeholder="Rechercher un produit..."
            oninput="Credits.filterCreditProds('${item.id}', this.value)"
            onfocus="Credits.filterCreditProds('${item.id}', this.value)"
            autocomplete="off"
          >
          ${selProd ? `<span class="prod-search-badge">${selProd.stock} en stock</span>` : ''}
          <div class="prod-drop hidden" id="cpdrop-${item.id}"></div>
        </div>
        <input type="number" min="1" value="${item.qty}" onchange="Credits.updateCreditItem('${item.id}','qty',this.value)" class="si-qty" placeholder="Qté">
        <input type="number" value="${item.price}" onchange="Credits.updateCreditItem('${item.id}','price',this.value)" class="si-price" placeholder="Prix">
        <div class="sale-item-total">${Utils.fmt(item.qty * item.price)}</div>
        <button class="btn-remove-item" onclick="Credits.removeCreditItem('${item.id}')">✕</button>
      </div>`;
    }).join('');
    this._updateCreditTotal();
  },

  filterCreditProds(itemId, query) {
    const drop = document.getElementById('cpdrop-' + itemId);
    if (!drop) return;
    const prods = DB.get('products') || [];
    const q = query.toLowerCase().trim();
    const matches = q.length === 0 ? prods : prods.filter(p =>
      p.name.toLowerCase().includes(q) || (p.category||'').toLowerCase().includes(q)
    );
    if (!matches.length) {
      drop.innerHTML = '<div class="prod-drop-empty">Aucun produit trouvé</div>';
      drop.classList.remove('hidden');
      return;
    }
    drop.innerHTML = matches.slice(0,10).map(p => {
      const stockCls = p.stock===0?'pdrop-out':p.stock<=3?'pdrop-low':'';
      return `<div class="prod-drop-item ${stockCls}" onclick="Credits.selectCreditProd('${itemId}','${p.id}')">
        <div class="pdi-name">${Utils.escHtml(p.name)}</div>
        <div class="pdi-meta">
          <span class="pdi-cat">${Utils.escHtml(p.category)}</span>
          <span class="pdi-price">${Utils.fmt(p.priceDetail)}</span>
          <span class="pdi-stock ${stockCls}">${p.stock===0?'Rupture':p.stock+' en stock'}</span>
        </div>
      </div>`;
    }).join('');
    drop.classList.remove('hidden');
  },

  selectCreditProd(itemId, productId) {
    const item = this.creditItems.find(i=>i.id===itemId);
    if (!item) return;
    const prod = (DB.get('products')||[]).find(p=>p.id===productId);
    if (!prod) return;
    item.productId   = productId;
    item.productName = prod.name;
    item.price       = prod.priceDetail;
    item.cost        = prod.cost;
    const drop = document.getElementById('cpdrop-' + itemId);
    if (drop) drop.classList.add('hidden');
    this._renderCreditItems();
  },

  updateCreditItem(itemId, field, val) {
    const item = this.creditItems.find(i=>i.id===itemId);
    if (!item) return;
    item[field] = field === 'qty' ? (parseInt(val)||1) : (parseFloat(val)||0);
    this._updateCreditTotal();
    // Update total cell inline
    const row = document.getElementById('cir-' + itemId);
    if (row) {
      const totEl = row.querySelector('.sale-item-total');
      if (totEl) totEl.textContent = Utils.fmt(item.qty * item.price);
    }
  },

  addCreditItem() {
    this.creditItems.push({ id: Utils.id(), productId:'', productName:'', qty:1, price:0, cost:0 });
    this._renderCreditItems();
  },

  removeCreditItem(itemId) {
    if (this.creditItems.length === 1) { Toast.show('Au moins un article requis','warning'); return; }
    this.creditItems = this.creditItems.filter(i=>i.id!==itemId);
    this._renderCreditItems();
  },

  _updateCreditTotal() {
    const total = this.creditItems.reduce((a,i) => a + (i.qty * i.price), 0);
    const paid  = parseFloat(document.getElementById('cr-paid')?.value)||0;
    const totEl = document.getElementById('cr-total-display');
    const leftEl= document.getElementById('cr-left-val');
    if (totEl) totEl.textContent = Utils.fmt(total);
    if (leftEl) leftEl.textContent = Utils.fmt(Math.max(0, total - paid));
  },

  _calcLeft() {
    const total = (this.creditItems||[]).reduce((a,i)=>a+(i.qty*i.price),0);
    const paid  = parseFloat(document.getElementById('cr-paid')?.value)||0;
    const leftEl= document.getElementById('cr-left-val');
    const totEl = document.getElementById('cr-total-display');
    if (totEl)  totEl.textContent  = Utils.fmt(total);
    if (leftEl) leftEl.textContent = Utils.fmt(Math.max(0, total-paid));
  },

  save() {
    const name = (document.getElementById('cr-client')?.value||'').trim();
    if (!name) { Toast.show('Nom du client requis', 'error'); return; }
    if (!this.creditItems.length || this.creditItems.every(i=>!i.productId && !i.productName)) {
      Toast.show('Sélectionnez au moins un produit', 'error'); return;
    }
    const totalDue   = this.creditItems.reduce((a,i)=>a+(i.qty*i.price),0);
    const amountPaid = parseFloat(document.getElementById('cr-paid')?.value)||0;
    const id = document.getElementById('cr-id')?.value;
    const status = amountPaid >= totalDue ? 'paid' : (amountPaid > 0 ? 'partial' : 'pending');
    // Build items summary string for display in table
    const itemsSummary = this.creditItems
      .filter(i=>i.productName||i.qty)
      .map(i=>`${i.qty}x ${i.productName||'Article'}`)
      .join(', ');
    const credit = {
      id: id || Utils.id(),
      date:       document.getElementById('cr-date')?.value || Utils.today(),
      dueDate:    document.getElementById('cr-due')?.value  || '',
      client:     name,
      phone:      (document.getElementById('cr-phone')?.value||'').trim(),
      items:      itemsSummary,
      creditItems: this.creditItems.map(i=>({...i})),
      totalDue,
      amountPaid,
      status,
      notes:      (document.getElementById('cr-notes')?.value||'').trim()
    };
    const credits = DB.get('credits') || [];
    if (id) { const idx=credits.findIndex(c=>c.id===id); if(idx>=0) credits[idx]=credit; else credits.push(credit); }
    else credits.push(credit);
    DB.set('credits', credits);
    App.forceCloseModal();
    this.render();
    Toast.show(id ? 'Crédit modifié' : 'Vente à crédit enregistrée — bénéfice comptabilisé à la réception du paiement');
  },

  addPayment(id) {
    const credits = DB.get('credits') || [];
    const c = credits.find(x=>x.id===id);
    if (!c) return;
    const left = Math.max(0, (c.totalDue||0)-(c.amountPaid||0));
    const amtStr = prompt(`Versement reçu de ${c.client}\nReste à payer : ${Utils.fmt(left)}\n\nMontant reçu (FCFA) :`);
    const amt = parseFloat(amtStr);
    if (!amt || isNaN(amt) || amt <= 0) return;
    c.amountPaid = (c.amountPaid||0) + amt;
    if (c.amountPaid >= c.totalDue) {
      c.status = 'paid';
      Toast.show(`✅ ${c.client} a tout payé ! La vente est soldée.`);
    } else {
      c.status = 'partial';
      Toast.show(`💰 Versement de ${Utils.fmt(amt)} enregistré. Reste : ${Utils.fmt(c.totalDue - c.amountPaid)}`);
    }
    DB.set('credits', credits);
    this.render();
  },

  delete(id) {
    if (!confirm('Supprimer cette vente à crédit ?')) return;
    DB.set('credits', (DB.get('credits')||[]).filter(c=>c.id!==id));
    this.render();
    Toast.show('Vente à crédit supprimée', 'warning');
  },

  exportExcel() {
    const credits = DB.get('credits') || [];
    if (!credits.length) { Toast.show('Aucune donnée à exporter', 'warning'); return; }
    const rows = [['Date','Client','Téléphone','Articles','Total dû','Reçu','Reste','Échéance','Statut']];
    credits.forEach(c => {
      rows.push([c.date, c.client, c.phone||'', c.items, c.totalDue, c.amountPaid||0,
        Math.max(0,(c.totalDue||0)-(c.amountPaid||0)), c.dueDate||'',
        {paid:'Soldé',partial:'Partiel',pending:'En attente'}[c.status]||'']);
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Credits');
    XLSX.writeFile(wb, `credits_${Utils.today()}.xlsx`);
    Toast.show('Export Excel téléchargé');
  }
};

// ========== AUTO BACKUP ==========
const AutoBackup = {
  SNAP_KEY: 'bmp_snapshots',
  LAST_KEY: 'bmp_last_save',
  _debounce: null,
  _timer: null,

  init() {
    // Sauvegarde automatique toutes les 30 minutes
    this._timer = setInterval(() => this._snapshot('auto'), 30 * 60 * 1000);
    // Mise à jour de l'indicateur toutes les minutes
    setInterval(() => this._updateIndicator(), 60 * 1000);
    this._updateIndicator();
  },

  // Appelé par DB.save() à chaque modification de données
  onDataChange() {
    clearTimeout(this._debounce);
    this._debounce = setTimeout(() => {
      this._snapshot('auto');
      this._updateIndicator();
    }, 2000); // Attendre 2s après la dernière modif
  },

  _snapshot(type) {
    try {
      const raw = JSON.stringify(DB.data);
      const encoded = 'BMP_V2_' + btoa(unescape(encodeURIComponent(raw)));
      const hist = this._getHistory();
      hist.unshift({
        id: Date.now(),
        ts: Date.now(),
        type,
        date: new Date().toLocaleString('fr-FR'),
        size: (new TextEncoder().encode(raw).length / 1024).toFixed(1),
        data: encoded
      });
      while (hist.length > 10) hist.pop();
      localStorage.setItem(this.SNAP_KEY, JSON.stringify(hist));
      localStorage.setItem(this.LAST_KEY, String(Date.now()));
    } catch(e) { console.warn('AutoBackup snapshot failed', e); }
  },

  _getHistory() {
    try { return JSON.parse(localStorage.getItem(this.SNAP_KEY)) || []; }
    catch(_) { return []; }
  },

  _updateIndicator() {
    const el = document.getElementById('auto-save-indicator');
    if (!el) return;
    const ts = parseInt(localStorage.getItem(this.LAST_KEY) || '0');
    if (!ts) { el.textContent = ''; return; }
    const m = Math.floor((Date.now() - ts) / 60000);
    el.textContent = m < 1 ? '✓ Sauvegardé' : m < 60 ? `✓ Sauvegardé il y a ${m} min` : `✓ Sauvegardé il y a ${Math.floor(m/60)}h`;
  },

  // Export manuel — télécharge un fichier .bmp
  exportNow() {
    this._snapshot('manual');
    const raw = JSON.stringify(DB.data);
    const encoded = 'BMP_V2_' + btoa(unescape(encodeURIComponent(raw)));
    const blob = new Blob([encoded], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const shop = (DB.get('settings').shopName || 'boutique').replace(/\s+/g, '_');
    a.href = url;
    a.download = `sauvegarde_${shop}_${Utils.today()}.bmp`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    Toast.show('Sauvegarde téléchargée ! Conservez ce fichier précieusement.');
    this._updateIndicator();
    AutoBackup.renderPanel();
  },

  // Restaurer depuis fichier .bmp ou .json
  restoreFromFile(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => this._restore(e.target.result, file.name);
    reader.readAsText(file, 'UTF-8');
    input.value = '';
  },

  _restore(content, filename) {
    try {
      let data;
      if (content.startsWith('BMP_V2_')) {
        data = JSON.parse(decodeURIComponent(escape(atob(content.slice(7)))));
      } else {
        data = JSON.parse(content);
      }
      if (!data || !data.products) { Toast.show('Fichier invalide ou corrompu', 'error'); return; }
      const info = `${(data.products||[]).length} produits · ${(data.sales||[]).length} ventes · ${(data.invoices||[]).length} factures`;
      if (!confirm(`Restaurer depuis "${filename}" ?\n${info}\n\nATTENTION : les données actuelles seront remplacées.`)) return;
      this._snapshot('auto'); // sauvegarder avant d'écraser
      DB.data = data;
      localStorage.setItem(DB.key, JSON.stringify(data));
      App.loadSettings();
      Dashboard.render();
      Toast.show('Restauration réussie ! Toutes vos données sont récupérées.');
      setTimeout(() => App.showPage('dashboard'), 600);
    } catch(e) {
      console.error(e);
      Toast.show('Fichier corrompu — impossible de restaurer', 'error');
    }
  },

  // Restaurer depuis un point local
  restoreSnapshot(idx) {
    const hist = this._getHistory();
    const entry = hist[idx];
    if (!entry) return;
    if (!confirm(`Restaurer le point du ${entry.date} ?\nLes données actuelles seront remplacées.`)) return;
    this._restore(entry.data, entry.date);
  },

  // Rend le panneau sauvegarde dans Paramètres
  renderPanel() {
    const panel = document.getElementById('abk-panel');
    if (!panel) return;
    const hist = this._getHistory();
    const ts = parseInt(localStorage.getItem(this.LAST_KEY) || '0');
    const lastStr = ts ? new Date(ts).toLocaleString('fr-FR') : 'Jamais';
    const prods = DB.get('products') || [];
    const valCost = prods.reduce((a,p) => a + (p.cost||0)*(p.stock||0), 0);

    const snapHTML = hist.length ? hist.map((h,i) => `
      <div class="abk-snap">
        <span class="abk-snap-icon">${h.type==='manual'?'💾':'🔄'}</span>
        <div class="abk-snap-info">
          <div class="abk-snap-date">${h.date}</div>
          <div class="abk-snap-meta">${h.type==='manual'?'Manuel':'Automatique'} · ${h.size} Ko</div>
        </div>
        <button class="btn-secondary abk-snap-btn" onclick="AutoBackup.restoreSnapshot(${i})">Restaurer</button>
      </div>`).join('')
    : '<div style="color:var(--text2);font-size:0.82rem;padding:0.75rem 0">Aucune sauvegarde locale. Modifiez des données pour en créer une.</div>';

    panel.innerHTML = `
      <div class="abk-status">
        <div class="abk-dot-pulse"></div>
        <div>
          <div class="abk-status-title">Sauvegarde automatique active</div>
          <div class="abk-status-sub">Dernière sauvegarde : <strong>${lastStr}</strong></div>
        </div>
      </div>

      <div class="abk-stats">
        <div class="abk-stat"><span>${prods.length}</span>Produits</div>
        <div class="abk-stat"><span>${(DB.get('sales')||[]).length}</span>Ventes</div>
        <div class="abk-stat"><span>${(DB.get('invoices')||[]).length}</span>Factures</div>
        <div class="abk-stat"><span>${(DB.get('expenses')||[]).length}</span>Dépenses</div>
        <div class="abk-stat accent"><span>${Utils.fmt(valCost)}</span>Valeur stock</div>
      </div>

      <div class="abk-buttons">
        <button class="btn-primary" onclick="AutoBackup.exportNow()">📥 Télécharger sauvegarde (.bmp)</button>
        <button class="btn-secondary" onclick="document.getElementById('abk-file').click()">📤 Restaurer depuis fichier</button>
        <input type="file" id="abk-file" accept=".bmp,.json" style="display:none" onchange="AutoBackup.restoreFromFile(this)">
      </div>

      <div class="abk-info">
        <strong>Comment changer de machine :</strong> téléchargez le fichier .bmp → transférez-le par email ou clé USB → ouvrez l'app sur le nouvel appareil → cliquez "Restaurer depuis fichier".
      </div>

      <div class="abk-snaps-title">Points de restauration locaux (${hist.length}/10)</div>
      <div class="abk-snaps">${snapHTML}</div>
    `;
  }
};

// ========== INIT ==========
document.addEventListener('DOMContentLoaded', () => {
  const savedTheme = localStorage.getItem('boutiqueTheme') || 'rose-gold';
  document.body.setAttribute('data-theme', savedTheme);

  // Charger les données locales (cache)
  App.init();
  AutoBackup.init();

  const fbkCfg = localStorage.getItem('fbk_config');
  if (fbkCfg) {
    // Firebase configuré → initialiser directement
    // onAuthStateChanged s'occupera d'entrer dans l'app si session active
    LoginMode._cloudInitDone = true;
    try {
      Cloud.init(JSON.parse(fbkCfg));
    } catch(e) {
      console.error('[Init] Cloud.init échoué:', e);
    }
  }
  // Pas de Firebase → écran de login local normal

  // Escape ne ferme plus les modals (évite perte de données accidentelle)
  // Utilisez le bouton ✕ ou Annuler
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      // Ne rien faire — le modal doit être fermé explicitement
    }
  });
});
