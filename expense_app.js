/**
 * 여행 가계부 - 앱 로직 (1단계: OCR 자동분류 + 수동입력 + 목록/요약 + 가족 동기화)
 *
 * 데이터는 localStorage에 저장되며, 웹앱 URL을 등록하면 Apps Script를 통해
 * 가족과 지출 데이터를 주고받을 수 있습니다 (수동 업로드/불러오기 방식).
 */

// ===== 설정 =====
// 배포한 Apps Script 웹앱 URL을 여기 기본값으로 넣어두면 매번 입력할 필요가 없습니다.
const DEFAULT_WEBHOOK_URL = '';

// 임시 고정 환율 (2단계에서 실시간 API로 교체 예정)
const FALLBACK_RATES_TO_KRW = {
  EUR: 1480,
  CZK: 59,
  CHF: 1620,
  KRW: 1
};

const STORAGE_KEY = 'expenseTrackerData_v1';
const WEBHOOK_KEY = 'expenseTrackerWebhookUrl';

const CATEGORY_EMOJI = {
  '식비': '🍽️', '교통': '🚌', '숙박': '🛏️', '쇼핑': '🛍️', '관광입장료': '🎫', '기타': '📦'
};

let state = {
  expenses: []
};

// ===== 초기화 =====
document.addEventListener('DOMContentLoaded', () => {
  loadFromLocalStorage();
  bindTabNav();
  bindScanTab();
  bindManualForm();
  bindEditModal();
  bindSyncButtons();

  const savedUrl = localStorage.getItem(WEBHOOK_KEY) || DEFAULT_WEBHOOK_URL;
  document.getElementById('webhookUrlInput').value = savedUrl;

  render();
});

function loadFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw);
    if (!state.expenses) state.expenses = [];
  } catch (e) {
    state = { expenses: [] };
  }
}

function saveToLocalStorage() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ===== 탭 전환 =====
function bindTabNav() {
  document.querySelectorAll('nav.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('section.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('panel-' + btn.dataset.tab).classList.add('active');
    });
  });
}

// ===== 촬영 탭 =====
let pendingImageBase64 = null;
let pendingImageMime = null;

function bindScanTab() {
  const fileInput = document.getElementById('fileInput');
  const previewImg = document.getElementById('previewImg');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const statusEl = document.getElementById('scanStatus');

  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    pendingImageMime = file.type || 'image/jpeg';

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      pendingImageBase64 = dataUrl.split(',')[1];
      previewImg.src = dataUrl;
      previewImg.style.display = 'block';
      analyzeBtn.disabled = false;
      statusEl.textContent = '';
      statusEl.className = 'status-msg';
    };
    reader.readAsDataURL(file);
  });

  analyzeBtn.addEventListener('click', async () => {
    const webhookUrl = localStorage.getItem(WEBHOOK_KEY) || DEFAULT_WEBHOOK_URL;
    if (!webhookUrl) {
      statusEl.textContent = '먼저 "요약" 탭에서 Apps Script 웹앱 URL을 등록해주세요.';
      statusEl.className = 'status-msg error';
      return;
    }
    if (!pendingImageBase64) return;

    analyzeBtn.disabled = true;
    statusEl.textContent = '🤖 영수증을 분석하는 중입니다...';
    statusEl.className = 'status-msg';

    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        body: JSON.stringify({
          action: 'ocr',
          imageBase64: pendingImageBase64,
          mimeType: pendingImageMime
        })
      });
      const data = await res.json();
      if (data.status !== 'ok') throw new Error(data.message || '분석 실패');

      statusEl.textContent = '✅ 분석 완료! 내용을 확인하고 저장하세요.';
      statusEl.className = 'status-msg ok';
      openEditModal(buildExpenseFromExtracted(data.extracted), 'new-from-ocr');
    } catch (err) {
      statusEl.textContent = '⚠️ 분석 실패: ' + err.message + ' (직접입력 탭에서 수동으로 입력할 수 있습니다)';
      statusEl.className = 'status-msg error';
    } finally {
      analyzeBtn.disabled = false;
    }
  });
}

function buildExpenseFromExtracted(extracted) {
  return {
    id: 'exp_' + Date.now(),
    date: extracted.date || new Date().toISOString().slice(0, 10),
    merchant: extracted.merchant || '',
    amount: extracted.amount || 0,
    currency: extracted.currency || 'EUR',
    category: extracted.category || '기타',
    city: '',
    memo: extracted.memo || '',
    driveUrl: extracted.driveUrl || '',
    createdAt: new Date().toISOString()
  };
}

// ===== 수동입력 탭 =====
function bindManualForm() {
  const form = document.getElementById('manualForm');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const expense = {
      id: 'exp_' + Date.now(),
      date: fd.get('date'),
      category: fd.get('category'),
      merchant: fd.get('merchant'),
      amount: parseFloat(fd.get('amount')),
      currency: fd.get('currency'),
      city: fd.get('city') || '',
      memo: fd.get('memo') || '',
      driveUrl: '',
      createdAt: new Date().toISOString()
    };
    state.expenses.push(expense);
    saveToLocalStorage();
    render();
    form.reset();

    document.querySelector('[data-tab="list"]').click();
  });
}

// ===== 수정 모달 =====
let editModalMode = 'edit'; // 'edit' | 'new-from-ocr'

function bindEditModal() {
  const overlay = document.getElementById('editModalOverlay');
  const form = document.getElementById('editForm');
  const closeBtn = document.getElementById('closeEditBtn');
  const deleteBtn = document.getElementById('deleteExpenseBtn');

  closeBtn.addEventListener('click', () => overlay.classList.remove('show'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const id = fd.get('id');
    const updated = {
      date: fd.get('date'),
      category: fd.get('category'),
      merchant: fd.get('merchant'),
      amount: parseFloat(fd.get('amount')),
      currency: fd.get('currency'),
      city: fd.get('city') || '',
      memo: fd.get('memo') || ''
    };

    if (editModalMode === 'new-from-ocr') {
      const newExpense = Object.assign({ id, driveUrl: form.dataset.driveUrl || '', createdAt: new Date().toISOString() }, updated);
      state.expenses.push(newExpense);
    } else {
      const idx = state.expenses.findIndex(x => x.id === id);
      if (idx > -1) state.expenses[idx] = Object.assign({}, state.expenses[idx], updated);
    }
    saveToLocalStorage();
    render();
    overlay.classList.remove('show');
  });

  deleteBtn.addEventListener('click', () => {
    const id = form.querySelector('[name="id"]').value;
    if (editModalMode === 'edit') {
      state.expenses = state.expenses.filter(x => x.id !== id);
      saveToLocalStorage();
      render();
    }
    overlay.classList.remove('show');
  });
}

function openEditModal(expense, mode) {
  editModalMode = mode || 'edit';
  const overlay = document.getElementById('editModalOverlay');
  const form = document.getElementById('editForm');
  form.querySelector('[name="id"]').value = expense.id;
  form.querySelector('[name="date"]').value = expense.date;
  form.querySelector('[name="category"]').value = expense.category;
  form.querySelector('[name="merchant"]').value = expense.merchant;
  form.querySelector('[name="amount"]').value = expense.amount;
  form.querySelector('[name="currency"]').value = expense.currency;
  form.querySelector('[name="city"]').value = expense.city || '';
  form.querySelector('[name="memo"]').value = expense.memo || '';
  form.dataset.driveUrl = expense.driveUrl || '';
  overlay.classList.add('show');
}

// ===== 렌더링 =====
function render() {
  renderTotal();
  renderList();
  renderSummary();
}

function toKrw(amount, currency) {
  const rate = FALLBACK_RATES_TO_KRW[currency] || 0;
  return amount * rate;
}

function renderTotal() {
  const totalKrw = state.expenses.reduce((sum, e) => sum + toKrw(e.amount, e.currency), 0);
  document.getElementById('totalKrw').textContent = '₩' + Math.round(totalKrw).toLocaleString();
  document.getElementById('totalSub').textContent = state.expenses.length
    ? state.expenses.length + '건 등록됨 (임시 환율 기준 환산)'
    : '아직 등록된 지출이 없습니다';
}

function renderList() {
  const container = document.getElementById('listContainer');
  if (!state.expenses.length) {
    container.innerHTML = '<div class="empty">아직 등록된 지출이 없습니다.<br>촬영 또는 직접입력 탭에서 추가해보세요.</div>';
    return;
  }

  const byDate = {};
  state.expenses.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).forEach(e => {
    if (!byDate[e.date]) byDate[e.date] = [];
    byDate[e.date].push(e);
  });

  let html = '';
  Object.keys(byDate).forEach(date => {
    html += '<div class="day-group"><div class="day-label">' + date + '</div><div class="card">';
    byDate[date].forEach(e => {
      html += '<div class="expense-item" data-id="' + e.id + '">' +
        '<div class="left">' +
        '<div class="cat">' + (CATEGORY_EMOJI[e.category] || '') + ' ' + e.category + (e.city ? ' · ' + e.city : '') + '</div>' +
        '<div class="merchant">' + escapeHtml(e.merchant || '(이름 미입력)') + '</div>' +
        (e.memo ? '<div class="meta">' + escapeHtml(e.memo) + '</div>' : '') +
        '</div>' +
        '<div class="amount">' + e.amount.toLocaleString() + ' ' + e.currency + '</div>' +
        '</div>';
    });
    html += '</div></div>';
  });
  container.innerHTML = html;

  container.querySelectorAll('.expense-item').forEach(item => {
    item.addEventListener('click', () => {
      const expense = state.expenses.find(x => x.id === item.dataset.id);
      if (expense) openEditModal(expense, 'edit');
    });
  });
}

function renderSummary() {
  const byCategory = {};
  const byCurrency = {};
  state.expenses.forEach(e => {
    byCategory[e.category] = (byCategory[e.category] || 0) + toKrw(e.amount, e.currency);
    byCurrency[e.currency] = (byCurrency[e.currency] || 0) + e.amount;
  });

  const catEl = document.getElementById('categorySummary');
  const currEl = document.getElementById('currencySummary');

  catEl.innerHTML = Object.keys(byCategory).length
    ? Object.entries(byCategory).map(([cat, krw]) =>
        '<div class="summary-row"><span>' + (CATEGORY_EMOJI[cat] || '') + ' ' + cat + '</span><span class="amt">₩' + Math.round(krw).toLocaleString() + '</span></div>'
      ).join('')
    : '<div class="empty">데이터 없음</div>';

  currEl.innerHTML = Object.keys(byCurrency).length
    ? Object.entries(byCurrency).map(([cur, amt]) =>
        '<div class="summary-row"><span>' + cur + '</span><span class="amt">' + amt.toLocaleString() + '</span></div>'
      ).join('')
    : '<div class="empty">데이터 없음</div>';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== 가족 동기화 =====
function bindSyncButtons() {
  document.getElementById('saveUrlBtn').addEventListener('click', () => {
    const url = document.getElementById('webhookUrlInput').value.trim();
    localStorage.setItem(WEBHOOK_KEY, url);
    setSyncStatus('URL이 저장되었습니다.', 'ok');
  });

  document.getElementById('uploadBtn').addEventListener('click', async () => {
    const url = localStorage.getItem(WEBHOOK_KEY);
    if (!url) return setSyncStatus('먼저 웹앱 URL을 저장해주세요.', 'error');
    setSyncStatus('업로드 중...', '');
    try {
      const res = await fetch(url, { method: 'POST', body: JSON.stringify({ action: 'sync', data: state }) });
      const data = await res.json();
      if (data.status !== 'ok') throw new Error(data.message);
      setSyncStatus('✅ 업로드 완료 (' + new Date().toLocaleTimeString() + ')', 'ok');
    } catch (err) {
      setSyncStatus('⚠️ 업로드 실패: ' + err.message, 'error');
    }
  });

  document.getElementById('downloadBtn').addEventListener('click', async () => {
    const url = localStorage.getItem(WEBHOOK_KEY);
    if (!url) return setSyncStatus('먼저 웹앱 URL을 저장해주세요.', 'error');
    setSyncStatus('불러오는 중...', '');
    try {
      const res = await fetch(url, { method: 'GET' });
      const data = await res.json();
      if (!data.expenses) throw new Error('서버에 데이터가 없습니다.');
      state = data;
      saveToLocalStorage();
      render();
      setSyncStatus('✅ 불러오기 완료 (' + new Date().toLocaleTimeString() + ')', 'ok');
    } catch (err) {
      setSyncStatus('⚠️ 불러오기 실패: ' + err.message, 'error');
    }
  });
}

function setSyncStatus(msg, type) {
  const el = document.getElementById('syncStatus');
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ' ' + type : '');
}
