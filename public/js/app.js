const STATUS_LABEL = { pending: '待审批', approved: '已通过', rejected: '未通过', withdrawn: '已撤回' };
const ACTION_LABEL = { submit: '提交申请', approve: '审批通过', reject: '审批拒绝', withdraw: '撤回申请' };
const AUDIT_ACTION_LABEL = { register: '用户注册', login: '登录系统', logout: '退出登录', submit_application: '提交申请', withdraw_application: '撤回申请', approve_application: '通过申请', reject_application: '拒绝申请' };

async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {});
  if (opts.body) headers['Content-Type'] = 'application/json';
  const resp = await fetch(path, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await resp.json().catch(function () { return {}; });
  if (!resp.ok) {
    const err = new Error(data.error || '请求失败');
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

function pad2(n) { return String(n).padStart(2, '0'); }

function toLocalInput(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

const app = Vue.createApp({
  data: function () {
    return {
      user: null,
      authMode: 'login',
      loginForm: { username: '', password: '' },
      registerForm: { username: '', name: '', password: '', confirm: '' },
      authError: '',
      authLoading: false,
      devices: [],
      currentView: 'submit',
      form: { device: '', start_time: '', end_time: '', target: '', purpose: '', applicant_name: '', applicant_contact: '' },
      formError: '',
      submitting: false,
      conflicts: [],
      conflictTimer: null,
      mineList: [],
      pendingList: [],
      allList: [],
      allTotal: 0,
      allPage: 1,
      allPageSize: 15,
      allFilter: { status: '', search: '' },
      calendarSlots: [],
      stats: { total: 0, counts: { pending: 0, approved: 0, rejected: 0, withdrawn: 0 }, byDevice: [], byMonthRaw: [], approveRate: 0 },
      toast: { visible: false, message: '', type: 'info', timer: null },
      detailApp: null,
      detailHistory: [],
      reviewApp: null,
      auditLogs: [],
      charts: {}
    };
  },

  computed: {
    minDateTime: function () { return toLocalInput(new Date()); },
    totalPages: function () { return Math.max(1, Math.ceil(this.allTotal / this.allPageSize)); }
  },

  methods: {
    fmtDateTime: function (s) {
      if (!s) return '—';
      const str = String(s);
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str)) return str.replace('T', ' ');
      const d = new Date(str);
      if (isNaN(d.getTime())) return str;
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    },
    statusLabel: function (s) { return STATUS_LABEL[s] || s; },
    actionLabel: function (a) { return ACTION_LABEL[a] || a; },
    auditActionLabel: function (a) { return AUDIT_ACTION_LABEL[a] || a; },

    showToast: function (message, type) {
      const self = this;
      if (this.toast.timer) clearTimeout(this.toast.timer);
      this.toast = { visible: true, message: message, type: type || 'info', timer: null };
      this.toast.timer = setTimeout(function () { self.toast.visible = false; }, 3000);
    },

    async checkMe() {
      try {
        const data = await api('/api/auth/me');
        this.user = data.user;
        await this.loadDevices();
        if (this.user) {
          if (this.user.role === 'admin') { this.currentView = 'pending'; }
          else { this.currentView = 'submit'; this.form.applicant_name = this.user.name; }
          this.go(this.currentView);
        }
      } catch (e) { console.error(e); }
    },

    async loadDevices() {
      try { const d = await api('/api/devices'); this.devices = d.devices || []; } catch (e) { console.error(e); }
    },

    switchAuth: function (mode) { this.authMode = mode; this.authError = ''; },

    async login() {
      this.authError = ''; this.authLoading = true;
      try {
        const data = await api('/api/auth/login', { method: 'POST', body: this.loginForm });
        this.user = data.user;
        this.loginForm = { username: '', password: '' };
        await this.loadDevices();
        if (this.user.role === 'admin') { this.currentView = 'pending'; }
        else { this.currentView = 'submit'; this.form.applicant_name = this.user.name; }
        this.showToast('登录成功，欢迎 ' + this.user.name, 'success');
        this.go(this.currentView);
      } catch (e) { this.authError = e.message; }
      finally { this.authLoading = false; }
    },

    async register() {
      this.authError = '';
      if (this.registerForm.password !== this.registerForm.confirm) { this.authError = '两次输入的密码不一致'; return; }
      this.authLoading = true;
      try {
        const data = await api('/api/auth/register', {
          method: 'POST',
          body: { username: this.registerForm.username, password: this.registerForm.password, name: this.registerForm.name }
        });
        this.user = data.user;
        this.registerForm = { username: '', name: '', password: '', confirm: '' };
        await this.loadDevices();
        this.currentView = 'submit'; this.form.applicant_name = this.user.name;
        this.showToast('注册成功，欢迎 ' + this.user.name, 'success');
        this.go(this.currentView);
      } catch (e) { this.authError = e.message; }
      finally { this.authLoading = false; }
    },

    async logout() {
      try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) {}
      this.user = null;
      this.currentView = 'submit';
      this.form = { device: '', start_time: '', end_time: '', target: '', purpose: '', applicant_name: '', applicant_contact: '' };
      this.formError = ''; this.conflicts = [];
      this.detailApp = null; this.reviewApp = null;
    },

    go: function (view) {
      this.currentView = view;
      if (view === 'mine') this.loadMine();
      else if (view === 'pending') this.loadPending();
      else if (view === 'all') this.loadAll();
      else if (view === 'calendar') this.loadCalendar();
      else if (view === 'stats') { const self = this; this.loadStats().then(function () { self.renderCharts(); }); }
      else if (view === 'audit') this.loadAudit();
    },

    checkConflictNow: function () {
      const self = this;
      if (this.conflictTimer) clearTimeout(this.conflictTimer);
      this.conflictTimer = setTimeout(function () { self.checkConflict(); }, 300);
    },

    async checkConflict() {
      this.conflicts = [];
      if (!this.form.device || !this.form.start_time || !this.form.end_time) return;
      if (this.form.start_time >= this.form.end_time) return;
      try {
        const q = '?device=' + encodeURIComponent(this.form.device) + '&start=' + encodeURIComponent(this.form.start_time) + '&end=' + encodeURIComponent(this.form.end_time);
        const data = await api('/api/applications/conflicts' + q);
        this.conflicts = data.conflicts || [];
      } catch (e) { console.error(e); }
    },

    resetForm: function () {
      const keep = this.form.applicant_name;
      this.form = { device: '', start_time: '', end_time: '', target: '', purpose: '', applicant_name: keep, applicant_contact: '' };
      this.formError = ''; this.conflicts = [];
    },

    async submitApplication() {
      this.formError = '';
      if (!this.form.start_time || !this.form.end_time) { this.formError = '请填写完整的使用时段'; return; }
      if (this.form.start_time >= this.form.end_time) { this.formError = '结束时间必须晚于开始时间'; return; }
      if (this.conflicts.length) { this.formError = '存在时段冲突，请调整时段后再提交'; return; }
      this.submitting = true;
      try {
        const data = await api('/api/applications', { method: 'POST', body: this.form });
        this.showToast('申请提交成功，编号 ' + data.app_no, 'success');
        this.resetForm();
        this.go('mine');
      } catch (e) {
        if (e.status === 409 && e.data && e.data.conflicts) { this.conflicts = e.data.conflicts; }
        this.formError = e.message;
      } finally { this.submitting = false; }
    },

    async loadMine() {
      try { const d = await api('/api/applications/mine'); this.mineList = d.applications || []; } catch (e) { this.showToast(e.message, 'error'); }
    },

    async withdraw(a) {
      if (!confirm('确定撤回申请 ' + a.app_no + ' 吗？')) return;
      try { await api('/api/applications/' + a.id + '/withdraw', { method: 'POST' }); this.showToast('申请已撤回', 'success'); this.loadMine(); }
      catch (e) { this.showToast(e.message, 'error'); }
    },

    async openDetail(id) {
      try { const d = await api('/api/applications/' + id); this.detailApp = d.application; this.detailHistory = d.history || []; }
      catch (e) { this.showToast(e.message, 'error'); }
    },

    async loadPending() {
      try { const d = await api('/api/admin/pending'); this.pendingList = d.applications || []; } catch (e) { this.showToast(e.message, 'error'); }
    },

    async loadAll() {
      try {
        const q = '?status=' + encodeURIComponent(this.allFilter.status) + '&search=' + encodeURIComponent(this.allFilter.search) + '&page=' + this.allPage + '&pageSize=' + this.allPageSize;
        const d = await api('/api/admin/applications' + q);
        this.allList = d.applications || []; this.allTotal = d.total || 0; this.allPage = d.page || 1;
      } catch (e) { this.showToast(e.message, 'error'); }
    },

    resetAllPage: function () { this.allPage = 1; this.loadAll(); },
    changePage: function (delta) { this.allPage += delta; this.loadAll(); },

    async loadCalendar() {
      try { const d = await api('/api/admin/calendar'); this.calendarSlots = d.slots || []; } catch (e) { this.showToast(e.message, 'error'); }
    },

    slotsForDevice: function (dev) {
      return this.calendarSlots.filter(function (s) { return s.device === dev; });
    },

    async loadStats() {
      try { this.stats = await api('/api/admin/stats'); } catch (e) { this.showToast(e.message, 'error'); }
    },

    async loadAudit() {
      try { const d = await api('/api/admin/audit'); this.auditLogs = d.logs || []; } catch (e) { this.showToast(e.message, 'error'); }
    },

    renderCharts: function () {
      const self = this;
      this.$nextTick(function () {
        if (!window.Chart) return;
        Object.keys(self.charts).forEach(function (k) { if (self.charts[k]) { self.charts[k].destroy(); self.charts[k] = null; } });
        const s = self.stats;
        const muted = '#8ea0bd';
        const statusCtx = document.getElementById('statusChart');
        if (statusCtx) {
          self.charts.status = new Chart(statusCtx, {
            type: 'doughnut',
            data: {
              labels: ['待审批', '已通过', '未通过', '已撤回'],
              datasets: [{ data: [s.counts.pending, s.counts.approved, s.counts.rejected, s.counts.withdrawn], backgroundColor: ['#f59e0b', '#22c55e', '#ef4444', '#94a3b8'], borderWidth: 0 }]
            },
            options: { plugins: { legend: { labels: { color: muted } } } }
          });
        }
        const deviceCtx = document.getElementById('deviceChart');
        if (deviceCtx) {
          const devices = (s.byDevice || []).map(function (r) { return r.device; });
          const counts = (s.byDevice || []).map(function (r) { return r.c; });
          self.charts.device = new Chart(deviceCtx, {
            type: 'bar',
            data: { labels: devices, datasets: [{ label: '申请量', data: counts, backgroundColor: '#3b82f6', borderRadius: 6 }] },
            options: { plugins: { legend: { display: false } }, scales: { x: { ticks: { color: muted } }, y: { ticks: { color: muted, precision: 0 } } } }
          });
        }
        const trendCtx = document.getElementById('trendChart');
        if (trendCtx) {
          const months = (s.byMonthRaw || []).map(function (r) { return r.ym; });
          const trendData = (s.byMonthRaw || []).map(function (r) { return r.c; });
          self.charts.trend = new Chart(trendCtx, {
            type: 'line',
            data: { labels: months, datasets: [{ label: '申请数量', data: trendData, borderColor: '#fbbf24', backgroundColor: 'rgba(251,191,36,0.15)', fill: true, tension: 0.3 }] },
            options: { plugins: { legend: { labels: { color: muted } } }, scales: { x: { ticks: { color: muted } }, y: { ticks: { color: muted, precision: 0 } } } }
          });
        }
      });
    },

    exportCsv: function () {
      this.showToast('正在生成 CSV 报表…', 'info');
      window.location.href = '/api/admin/export.csv?_=' + Date.now();
    },

    openReview: function (a, action) {
      this.reviewApp = { app: a, action: action, comment: '', force: false, conflicts: [], error: '', submitting: false };
      if (action === 'approve') this.loadReviewConflicts(a);
    },

    async loadReviewConflicts(a) {
      try {
        const d = await api('/api/admin/calendar');
        const slots = d.slots || [];
        const conflicts = slots.filter(function (s) { return s.device === a.device && s.id !== a.id && s.start_time < a.end_time && s.end_time > a.start_time; });
        this.reviewApp.conflicts = conflicts;
      } catch (e) { console.error(e); }
    },

    closeReview: function () { this.reviewApp = null; },

    async doReview() {
      const r = this.reviewApp;
      if (!r) return;
      r.error = '';
      if (r.action === 'reject' && !r.comment) { r.error = '拒绝时必须填写审批意见'; return; }
      if (r.conflicts.length && !r.force) { r.error = '存在冲突时段，请勾选强制通过或调整'; return; }
      r.submitting = true;
      try {
        await api('/api/admin/applications/' + r.app.id + '/review', { method: 'POST', body: { action: r.action, comment: r.comment, force: r.force } });
        this.showToast((r.action === 'approve' ? '已同意' : '已驳回') + '申请 ' + r.app.app_no, 'success');
        this.closeReview();
        this.loadPending(); this.loadCalendar(); this.loadStats();
      } catch (e) {
        if (e.status === 409 && e.data && e.data.conflicts) { r.conflicts = e.data.conflicts; r.error = e.message; }
        else { r.error = e.message; }
      } finally { r.submitting = false; }
    }
  },

  mounted: function () { this.checkMe(); }
});

app.mount('#app');
