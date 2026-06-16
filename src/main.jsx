import React, { Component, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import './styles.css';

const APP_BUILD_VERSION = 'v25-20260616011517';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

async function fetchAllRows(tableName, selectText = '*', orderColumn = null) {
  const pageSize = 1000;
  let from = 0;
  let allRows = [];

  while (true) {
    let query = supabase.from(tableName).select(selectText).range(from, from + pageSize - 1);
    if (orderColumn) query = query.order(orderColumn, { ascending: true });

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    allRows = allRows.concat(rows);

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}


const CALL_RESULTS = {
  '통화 완료': ['불만사항없음', '불만사항있음'],
  '부재중': ['카카오톡발송', '문자발송'],
  '통화 불가': ['2nd디바이스', '타점 변경', '통신사 이동', '해지', '마케팅 미동의', '고객사정', '미성년자', '사고 발생건']
};

function isUnavailableCall(result, detail) {
  return result === '통화 불가' || result === '통화거부' || detail === '통화거부' ||
    ['2nd디바이스', '타점 변경', '통신사 이동', '해지', '마케팅 미동의', '고객사정', '미성년자', '사고 발생건'].includes(detail);
}

function shouldExcludeUnavailable(detail) {
  return isUnavailableCall('통화 불가', detail) && detail !== '미성년자';
}

function toComparableDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  const normalized = String(value).replace(/\./g, '-').replace(/\s+/g, '').slice(0, 10);
  const d2 = new Date(normalized);
  return Number.isNaN(d2.getTime()) ? null : d2.getTime();
}

function isNewOpeningAfterRefusal(openDate, refusedAt) {
  const openTime = toComparableDate(openDate);
  const refusedTime = toComparableDate(refusedAt);
  if (!openTime || !refusedTime) return false;
  return openTime > refusedTime;
}

function shouldSkipByRefusedCustomer(customer, refusedMap, callType = '') {
  if (isD95D185Type(callType)) return false;
  const refused = refusedMap?.[customer.join_no];
  if (!refused) return false;
  if (isNewOpeningAfterRefusal(customer.open_date, refused.refused_at)) return false;
  return true;
}

function dayOfWeekLocal(dateText) {
  return new Date(`${dateText}T00:00:00`).getDay();
}
function isMondayLocal(dateText) { return dayOfWeekLocal(dateText) === 1; }
function isSaturdayLocal(dateText) { return dayOfWeekLocal(dateText) === 6; }
function addDaysText(dateText, days) {
  const d = new Date(`${dateText}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}



class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div className="page center">
          <div className="loginCard">
            <h1>화면 오류</h1>
            <p className="error">{this.state.error.message}</p>
            <p className="muted">화면을 새로고침하거나 관리자에게 이 메시지를 전달해주세요.</p>
            <button className="primary" onClick={() => location.reload()}>새로고침</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}


function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem('happycall_user');
    return saved ? JSON.parse(saved) : null;
  });

  if (!supabaseUrl || !supabaseAnonKey) return <EnvMissing />;
  if (!user) return <Login onLogin={setUser} />;

  return (
    <ErrorBoundary>
      <MainApp
        user={user}
        onUserUpdate={(nextUser) => {
          localStorage.setItem('happycall_user', JSON.stringify(nextUser));
          setUser(nextUser);
        }}
        onLogout={() => {
          localStorage.removeItem('happycall_user');
          setUser(null);
        }}
      />
    </ErrorBoundary>
  );
}

function EnvMissing() {
  return (
    <div className="page center">
      <div className="loginCard">
        <h1>세찬 해피콜 관리시스템</h1>
        <p className="error">Supabase 연결값이 설정되지 않았습니다.</p>
        <p className="muted">Vercel 환경변수에 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY를 넣어주세요.</p>
      </div>
    </div>
  );
}


const LOGIN_STORE_ORDER = ['금촌', '야당', '봉일천', '화정', '능곡', '관리직'];

function normalizeLoginStoreName(storeName, role) {
  const s = String(storeName || '').trim();
  if (role === '관리자' || role === '검수자' || s === '관리자' || s === '본사' || s === '관리직') return '관리직';
  if (s.includes('금촌')) return '금촌';
  if (s.includes('야당')) return '야당';
  if (s.includes('봉일천')) return '봉일천';
  if (s.includes('화정')) return '화정';
  if (s.includes('능곡')) return '능곡';
  return s || '관리직';
}

function sortEmployeesForLogin(rows) {
  return [...(rows || [])].sort((a, b) => {
    const as = normalizeLoginStoreName(a.store_name, a.role);
    const bs = normalizeLoginStoreName(b.store_name, b.role);
    const ai = LOGIN_STORE_ORDER.includes(as) ? LOGIN_STORE_ORDER.indexOf(as) : 999;
    const bi = LOGIN_STORE_ORDER.includes(bs) ? LOGIN_STORE_ORDER.indexOf(bs) : 999;
    if (ai !== bi) return ai - bi;

    const roleRank = (r) => r === '점장' ? 0 : r === '관리자' ? 0 : r === '검수자' ? 1 : 2;
    const ar = roleRank(a.role);
    const br = roleRank(b.role);
    if (ar !== br) return ar - br;

    return String(a.name || '').localeCompare(String(b.name || ''), 'ko');
  });
}

function Login({ onLogin }) {
  const [employees, setEmployees] = useState([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { loadEmployees(); }, []);

  async function loadEmployees() {
    const { data, error } = await supabase.from('employees').select('*').eq('status', '재직').order('name');
    if (error) setErr(error.message);
    setEmployees(sortEmployeesForLogin(data || []));
  }

  function login() {
    setErr('');
    const emp = employees.find(e => e.name === name);
    if (!emp) return setErr('직원을 선택해주세요.');
    if (emp.status !== '재직') return setErr('퇴사 처리된 직원입니다. 관리자에게 문의하세요.');
    if ((emp.password || '') !== password) return setErr('비밀번호가 맞지 않습니다.');
    localStorage.setItem('happycall_user', JSON.stringify(emp));
    onLogin(emp);
  }

  return (
    <div className="page center">
      <div className="loginCard">
        <h1>세찬 해피콜 관리시스템</h1>
        <p className="subtitle">고객 관리 · 해피콜 · VOC 통합 시스템</p>
        <label>직원 선택</label>
        <select value={name} onChange={e => setName(e.target.value)}>
          <option value="">직원을 선택하세요</option>
          {employees.map(e => <option key={e.id} value={e.name}>{e.name} / {e.store_name} / {e.role || '직원'}</option>)}
        </select>
        <label>비밀번호</label>
        <input type="password" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if(e.key === 'Enter') login(); }} placeholder="비밀번호 입력" />
        {err && <p className="error">{err}</p>}
        <button className="primary" onClick={login}>로그인</button>
      </div>
    </div>
  );
}

function PasswordChangeModal({ user, onClose, onUserUpdate }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [busy, setBusy] = useState(false);

  async function changePassword() {
    if ((user.password || '') !== current) return alert('현재 비밀번호가 맞지 않습니다.');
    if (next.length < 4) return alert('새 비밀번호는 4자리 이상으로 입력해주세요.');
    if (next !== confirmPw) return alert('새 비밀번호 확인이 일치하지 않습니다.');

    setBusy(true);
    const { error } = await supabase.from('employees').update({ password: next }).eq('id', user.id);
    setBusy(false);
    if (error) return alert(error.message);

    const nextUser = { ...user, password: next };
    onUserUpdate(nextUser);
    await writeAuditLog('비밀번호변경', 'employee', user.id, user, `${user.name} 비밀번호 변경`);
    alert('비밀번호가 변경되었습니다.');
    onClose();
  }

  return (
    <div className="modalBg">
      <div className="modal smallModal">
        <div className="modalHead"><h2>비밀번호 변경</h2><button onClick={onClose}>닫기</button></div>
        <section>
          <label>현재 비밀번호</label>
          <input type="password" value={current} onChange={e=>setCurrent(e.target.value)} />
          <label>새 비밀번호</label>
          <input type="password" value={next} onChange={e=>setNext(e.target.value)} />
          <label>새 비밀번호 확인</label>
          <input type="password" value={confirmPw} onChange={e=>setConfirmPw(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') changePassword(); }} />
          <button className="primary" onClick={changePassword} disabled={busy}>변경하기</button>
        </section>
      </div>
    </div>
  );
}



async function saveErrorReport({ user, currentTab = '', actionName = '', joinNo = '', error }) {
  const message = error?.message || String(error || '알 수 없는 오류');
  try {
    await supabase.from('error_reports').insert({
      reporter_name: user?.name || '',
      reporter_role: user?.role || '',
      reporter_store: user?.store_name || '',
      current_tab: currentTab || '',
      action_name: actionName || '',
      join_no: joinNo || '',
      error_message: message,
      user_agent: navigator.userAgent,
      status: '접수'
    });
    alert('오류 보고가 접수되었습니다.');
  } catch (e) {
    alert('오류 보고 저장 실패: ' + e.message);
  }
}

function askErrorReport({ user, currentTab = '', actionName = '', joinNo = '', error }) {
  const message = error?.message || String(error || '알 수 없는 오류');
  const ok = confirm(`오류가 발생했습니다.\n\n${message}\n\n이 오류를 관리자에게 보고할까요?`);
  if (ok) saveErrorReport({ user, currentTab, actionName, joinNo, error });
}


function UpdateNotice({ user }) {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [nextVersion, setNextVersion] = useState('');
  const [changes, setChanges] = useState([]);

  useEffect(() => {
    let alive = true;
    let timer;

    function visibleRolesForUser(role) {
      if (role === '관리자') return ['직원', '점장', '검수자', '관리자'];
      if (role === '점장') return ['직원', '점장'];
      if (role === '검수자') return ['직원', '검수자'];
      return ['직원'];
    }

    function filterChangesByRole(rawChanges) {
      const role = user?.role || '직원';
      const allowed = visibleRolesForUser(role);
      if (!Array.isArray(rawChanges)) return [];
      return rawChanges
        .map(item => {
          if (typeof item === 'string') return item;
          if (item && Array.isArray(item.roles) && item.roles.some(r => allowed.includes(r))) return item.text;
          return null;
        })
        .filter(Boolean);
    }

    async function checkVersion() {
      try {
        const url = `/version.json?version_check=${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const res = await fetch(url, {
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
          }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!alive) return;

        if (data.version && data.version !== APP_BUILD_VERSION) {
          setNextVersion(data.version);
          // latestChanges only: 누적 변경내역이 아니라 이번 배포 변경분만 표시
          setChanges(filterChangesByRole(data.latestChanges || data.changes || []));
          setHasUpdate(true);
        }
      } catch (e) {}
    }

    function handleVisible() {
      if (document.visibilityState === 'visible') checkVersion();
    }

    checkVersion();
    timer = setInterval(checkVersion, 30 * 1000);
    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('focus', checkVersion);
    window.addEventListener('pageshow', checkVersion);
    window.addEventListener('online', checkVersion);
    window.addEventListener('touchstart', checkVersion, { passive: true, once: true });

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('focus', checkVersion);
      window.removeEventListener('pageshow', checkVersion);
      window.removeEventListener('online', checkVersion);
      window.removeEventListener('touchstart', checkVersion);
    };
  }, [user?.role]);

  async function forceRefresh() {
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
      }
    } catch (e) {}

    window.location.replace(`${window.location.origin}${window.location.pathname}?app_refresh=${Date.now()}`);
  }

  if (!hasUpdate) return null;

  return (
    <div className="updateNoticeBg">
      <div className="updateNoticeBox">
        <h2>업데이트 내용이 있습니다</h2>
        <p>새로운 버전이 배포되었습니다. 최신 기능과 오류 수정을 반영하려면 새로고침이 필요합니다.</p>

        {changes.length > 0 && (
          <div className="updateChangeBox">
            <h3>이번 수정 내용</h3>
            <ul>
              {changes.map((item, idx) => <li key={idx}>{item}</li>)}
            </ul>
          </div>
        )}

        <p className="muted">현재 버전: {APP_BUILD_VERSION}<br />최신 버전: {nextVersion}</p>
        <button className="primary" onClick={forceRefresh}>강제 새로고침</button>
      </div>
    </div>
  );
}

function AutoLogoutGuard({ onLogout }) {
  useEffect(() => {
    const TIMEOUT_MS = 60 * 60 * 1000;
    const WARN_MS = 55 * 60 * 1000;
    let warnTimer;
    let logoutTimer;

    function resetTimers() {
      clearTimeout(warnTimer);
      clearTimeout(logoutTimer);
      warnTimer = setTimeout(() => {
        const keep = confirm('5분 후 자동 로그아웃됩니다. 계속 사용하시겠습니까?');
        if (keep) resetTimers();
      }, WARN_MS);
      logoutTimer = setTimeout(() => {
        alert('60분 동안 활동이 없어 자동 로그아웃되었습니다.');
        onLogout();
      }, TIMEOUT_MS);
    }

    const events = ['click', 'keydown', 'touchstart', 'scroll'];
    events.forEach(ev => window.addEventListener(ev, resetTimers, { passive: true }));
    resetTimers();

    return () => {
      clearTimeout(warnTimer);
      clearTimeout(logoutTimer);
      events.forEach(ev => window.removeEventListener(ev, resetTimers));
    };
  }, [onLogout]);

  return null;
}

function MainApp({ user, onLogout, onUserUpdate }) {
  const [tab, setTab] = useState('mycalls');
  const [showPassword, setShowPassword] = useState(false);
  const [openMenu, setOpenMenu] = useState('');
  const isAdmin = user.role === '관리자';
  const isManager = user.role === '점장';
  const isChecker = user.role === '검수자' || user.role === '관리자';

  return (
    <div className="app">
      <AutoLogoutGuard onLogout={onLogout} />
      <UpdateNotice user={user} />
      <header>
        <div>
          <h1>세찬 해피콜 관리시스템</h1>
          <p>{user.name} · {user.store_name} · {user.role || '직원'}</p>
        </div>
        <div className="headerActions"><button onClick={() => setShowPassword(true)}>비밀번호 변경</button><button onClick={onLogout}>로그아웃</button></div>
      </header>

      <nav className="topNav compactNav">
        <button className={tab==='mycalls'?'active':''} onClick={()=>setTab('mycalls')}>내 해피콜</button>
        {isAdmin && <button className={tab==='rawupload'?'active':''} onClick={()=>setTab('rawupload')}>RAW 업로드</button>}
        {isAdmin && <button className={tab==='targetgen'?'active':''} onClick={()=>setTab('targetgen')}>해피콜 생성</button>}

        {isManager && (
          <div className="compactGroup">
            <button type="button" className="compactHead" onClick={()=>setOpenMenu(openMenu === 'store' ? '' : 'store')}>
              매장관리 {openMenu === 'store' ? '▲' : '▼'}
            </button>
            {openMenu === 'store' && (
              <div className="compactItems">
                <button className={tab==='manager'?'active':''} onClick={()=>setTab('manager')}>매장 현황</button>
                <button className={tab==='storecalls'?'active':''} onClick={()=>setTab('storecalls')}>매장 리스트</button>
                <button className={tab==='storePerformance'?'active':''} onClick={()=>setTab('storePerformance')}>직원별 현황</button>
              </div>
            )}
          </div>
        )}

        {isAdmin && (
          <div className="compactGroup">
            <button type="button" className="compactHead" onClick={()=>setOpenMenu(openMenu === 'ops' ? '' : 'ops')}>
              운영관리 {openMenu === 'ops' ? '▲' : '▼'}
            </button>
            {openMenu === 'ops' && (
              <div className="compactItems">
                <button className={tab==='employees'?'active':''} onClick={()=>setTab('employees')}>직원관리</button>
                <button className={tab==='stores'?'active':''} onClick={()=>setTab('stores')}>매장관리</button>
              </div>
            )}
          </div>
        )}

        {(isAdmin || isChecker) && (
          <div className="compactGroup">
            <button type="button" className="compactHead" onClick={()=>setOpenMenu(openMenu === 'review' ? '' : 'review')}>
              검수/현황 {openMenu === 'review' ? '▲' : '▼'}
            </button>
            {openMenu === 'review' && (
              <div className="compactItems">
                <button className={tab==='review'?'active':''} onClick={()=>setTab('review')}>검수</button>
                <button className={tab==='allcalls'?'active':''} onClick={()=>setTab('allcalls')}>전체 해피콜</button>
                <button className={tab==='performance'?'active':''} onClick={()=>setTab('performance')}>직원별 현황</button>
              </div>
            )}
          </div>
        )}

        {isAdmin && (
          <div className="compactGroup">
            <button type="button" className="compactHead" onClick={()=>setOpenMenu(openMenu === 'logs' ? '' : 'logs')}>
              기록 {openMenu === 'logs' ? '▲' : '▼'}
            </button>
            {openMenu === 'logs' && (
              <div className="compactItems">
                <button className={tab==='audit'?'active':''} onClick={()=>setTab('audit')}>감사로그</button>
                <button className={tab==='refused'?'active':''} onClick={()=>setTab('refused')}>통화 불가 고객</button>
                <button className={tab==='errors'?'active':''} onClick={()=>setTab('errors')}>오류보고</button>
              </div>
            )}
          </div>
        )}

        <button className={tab==='suggestions'?'active':''} onClick={()=>setTab('suggestions')}>건의/문의</button>
              <button className={tab==='guide'?'active':''} onClick={()=>setTab('guide')}>사용방법</button>
      </nav>

      <main>
        {tab === 'dashboard' && <Dashboard user={user} />}
        {tab === 'mycalls' && <CallList user={user} mode="mine" />}
        {tab === 'suggestions' && <SuggestionsPage user={user} />}
        {tab === 'guide' && <UsageGuide user={user} />}
        {tab === 'manager' && <ManagerStoreDashboardV6 user={user} />}
        {tab === 'storecalls' && <CallList user={user} mode="store" readOnly={true} />}
        {tab === 'storePerformance' && <EmployeePerformanceDashboard user={user} mode="store" />}
        {tab === 'review' && <ReviewDashboard user={user} />}
        {tab === 'performance' && <EmployeePerformanceDashboard user={user} mode="all" />}
        {tab === 'audit' && <AuditLogsViewer />}
        {tab === 'refused' && <RefusedCustomersViewer />}
        {tab === 'errors' && <ErrorReportsViewer user={user} />}
        {tab === 'allcalls' && <CallList user={user} mode="all" />}
        {tab === 'employees' && <Employees user={user} />}
        {tab === 'stores' && <Stores user={user} />}
        {tab === 'rawupload' && <RawUpload user={user} />}
        {tab === 'targetgen' && <TargetGenerator user={user} />}
      </main>
      {showPassword && <PasswordChangeModal user={user} onClose={() => setShowPassword(false)} onUserUpdate={onUserUpdate} />}
    </div>
  );
}





function formatAuditPatch(patch) {
  if (!patch) return '';
  const labels = { name:'이름', store_name:'매장', status:'상태', password:'비밀번호', role:'권한', successor_store:'승계매장' };
  return Object.entries(patch).map(([k, v]) => `${labels[k] || k}: ${k === 'password' ? '변경됨' : v}`).join(' / ');
}

async function writeAuditLog(action, targetType, targetId, actor, detail = '') {
  try {
    await supabase.from('audit_logs').insert({
      action,
      target_type: targetType,
      target_id: targetId,
      actor_name: actor?.name || actor || '',
      detail
    });
  } catch (e) {
    console.warn('audit log skipped:', e.message);
  }
}

function todayLocalISO() {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}
function diffDays(dateText, baseText = todayLocalISO()) {
  const a = new Date(String(dateText).slice(0, 10) + 'T00:00:00');
  const b = new Date(String(baseText).slice(0, 10) + 'T00:00:00');
  return Math.floor((b - a) / 86400000);
}

function formatKST(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value).slice(0, 19).replace('T', ' ');
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(d).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function calculateCallStats(targets, latestLogByTarget, today = todayLocalISO()) {
  const total = targets.length;
  const isRejected = (t) => latestLogByTarget[t.id]?.review_status === '반려';
  const isCompleted = (t) => latestLogByTarget[t.id] && !isRejected(t);
  const done = targets.filter(isCompleted).length;
  const rejected = targets.filter(isRejected).length;
  const pending = targets.filter(t => !latestLogByTarget[t.id] || isRejected(t)).length;
  const todayTargets = targets.filter(t => t.target_date === today);
  const todayDone = todayTargets.filter(isCompleted).length;
  const overdueTargets = targets.filter(t => (!latestLogByTarget[t.id] || isRejected(t)) && diffDays(t.target_date, today) > 0);
  const voc = targets.filter(t => latestLogByTarget[t.id]?.call_detail === '불만사항있음').length;
  const absent = targets.filter(t => latestLogByTarget[t.id]?.call_result === '부재중').length;
  return { total, done, pending, rate: total ? Math.round(done/total*1000)/10 : 0,
    todayTotal: todayTargets.length, todayDone, todayPending: todayTargets.length - todayDone,
    todayRate: todayTargets.length ? Math.round(todayDone/todayTargets.length*1000)/10 : 0,
    overdue: overdueTargets.length, voc, absent, rejected };
}
function sortTargetsByPriority(a, b, latestLogByTarget, today = todayLocalISO()) {
  const rank = (t) => {
    if (latestLogByTarget[t.id]) return 3;
    const d = diffDays(t.target_date, today);
    if (d > 0) return 0;
    if (d === 0) return 1;
    return 2;
  };
  const r = rank(a)-rank(b);
  if (r !== 0) return r;
  const da = diffDays(a.target_date, today);
  const db = diffDays(b.target_date, today);
  if (!latestLogByTarget[a.id] && !latestLogByTarget[b.id] && da !== db) return db-da;
  return String(b.target_date).localeCompare(String(a.target_date));
}
function StatusBadge({ target, log }) {
  if (log) return <span className="badge done">완료</span>;
  const overdueDays = diffDays(target.target_date);
  if (overdueDays > 0) return <span className={overdueDays >= 3 ? "badge danger" : "badge warn"}>{overdueDays}일 경과</span>;
  if (overdueDays === 0) return <span className="badge today">오늘 신규</span>;
  return <span className="badge">예정</span>;
}



function LastAuditNotice({ action, label }) {
  const [item, setItem] = useState(null);

  useEffect(() => { load(); }, [action]);

  async function load() {
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('action', action)
        .order('created_at', { ascending: false })
        .limit(1);

      if (error) throw error;
      setItem((data || [])[0] || null);
    } catch (e) {
      console.warn('last audit load skipped:', e.message);
    }
  }

  return (
    <div className="lastAuditNotice">
      <b>{label}</b><br />
      {item ? (
        <>
          <span>{formatKST(item.created_at)}</span>
          <span> / 작업자: {item.actor_name || '-'}</span>
          {item.detail && <p>{item.detail}</p>}
        </>
      ) : (
        <span>아직 기록 없음</span>
      )}
    </div>
  );
}

function UsageGuide({ user }) {
  const role = user?.role || '직원';

  const guideMap = {
    직원: {
      title: '직원 사용방법',
      items: [
        '내 해피콜 탭에서 본인에게 배정된 고객을 확인합니다.',
        '고객을 눌러 개통 이력과 연락 스크립트를 확인합니다.',
        '통화 결과와 상세 결과를 직접 선택한 뒤 저장합니다.',
        '검수 반려 건은 반려 사유를 확인하고 다시 저장합니다.'
      ]
    },
    검수자: {
      title: '검수자 사용방법',
      items: [
        '검수 탭에서 검수대기 건을 확인합니다.',
        '직원 입력 결과와 메모를 확인합니다.',
        '이상이 없으면 검수 승인, 보완이 필요하면 반려 처리합니다.',
        '반려 시 직원이 이해할 수 있게 반려 사유를 작성합니다.',
        '직원별 현황에서 진행률과 반려 현황을 확인합니다.'
      ]
    },
    점장: {
      title: '점장 사용방법',
      items: [
        '매장 해피콜 현황에서 당일 진행률과 경과 미완료를 확인합니다.',
        '직원별 현황에서 직원별 완료율, 미완료, 반려 건수를 확인합니다.',
        '고객 상세는 확인용이며 점장 화면에서는 결과 수정이 불가합니다.',
        '미완료가 누적되는 직원은 별도로 진행 여부를 체크합니다.'
      ]
    },
    관리자: {
      title: '관리자 사용방법',
      items: [
        'RAW 업로드에서 엑셀을 분석하고 customers DB에 저장합니다.',
        '해피콜 생성에서 대상일 기준 대상자를 계산하고 저장합니다.',
        '직원관리에서 재직/퇴사/권한/비밀번호/근무이력을 관리합니다.',
        '매장관리에서 운영/폐점/승계매장을 관리합니다.',
        '검수, 전체 해피콜, 직원별 현황, 감사로그를 확인합니다.'
      ]
    }
  };

  const hierarchy = {
    직원: ['직원'],
    검수자: ['검수자', '직원'],
    점장: ['점장', '직원'],
    관리자: ['관리자', '점장', '검수자', '직원']
  };

  const visibleRoles = hierarchy[role] || ['직원'];

  return (
    <div>
      <h2>사용방법</h2>
      <div className="guideGrid roleGuideGrid">
        {visibleRoles.map(r => {
          const guide = guideMap[r];
          return (
            <section className="sectionCard guideFocus" key={r}>
              <h3>{guide.title}</h3>
              <ol>
                {guide.items.map((item, idx) => <li key={idx}>{item}</li>)}
              </ol>
            </section>
          );
        })}
      </div>

      <div className="sectionCard">
        <h3>현재 로그인 권한</h3>
        <p><b>{user.name}</b> / {user.store_name} / {role}</p>
      </div>
    </div>
  );
}

function Dashboard({ user }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const allTargets = await fetchAllRows('happycall_targets', '*', 'target_date');
      const allLogs = await fetchAllRows('happycall_logs', '*', 'checked_at');
      let visible = (allTargets || []).filter(t => !t.is_skipped);
      if (user?.role === '점장') visible = visible.filter(t => t.assigned_store === user.store_name);
      setTargets(visible);
      setLogs(allLogs || []);
    } catch (e) {
      alert('대시보드 조회 오류: ' + e.message);
    }
  }

  const latestLogByTarget = useMemo(() => {
    const map = {};
    logs.forEach(l => {
      const prev = map[l.target_id];
      if (!prev) {
        map[l.target_id] = l;
        return;
      }
      if (l.review_status === '반려' && prev.review_status !== '반려') {
        map[l.target_id] = l;
        return;
      }
      if (String(l.checked_at || '') > String(prev.checked_at || '')) {
        map[l.target_id] = l;
      }
    });
    return map;
  }, [logs]);

  const stats = useMemo(() => {
    const base = calculateCallStats(targets, latestLogByTarget);
    const rejected = targets.filter(t => latestLogByTarget[t.id]?.review_status === '반려').length;
    return { ...base, rejected, pending: base.pending + rejected };
  }, [targets, latestLogByTarget]);

  return (
    <div>
      <h2>대시보드</h2>
      <div className="stats">
        <Card title="전체 대상" value={stats.total} />
        <Card title="전체 완료율" value={`${stats.rate}%`} />
        <Card title="오늘 작업 완료율" value={`${stats.todayRate}%`} />
        <Card title="경과 미완료" value={stats.overdue} />
      </div>
      <div className="stats miniStats">
        <Card title="완료" value={stats.done} />
        <Card title="미완료" value={stats.pending} />
        <Card title="오늘 신규" value={stats.todayTotal} />
        <Card title="VOC" value={stats.voc} />
      </div>
    </div>
  );
}

function Card({ title, value }) {
  return <div className="stat"><span>{title}</span><b>{value}</b></div>;
}


function CallList({ user, mode, readOnly = false }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [customersByJoinNo, setCustomersByJoinNo] = useState({});
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('미완료전체');
  const [bulkTempOpen, setBulkTempOpen] = useState(false);
  const [storeFilter, setStoreFilter] = useState('전체');
  const [employeeFilter, setEmployeeFilter] = useState('전체');

  useEffect(() => { load(); }, [mode]);

  async function load() {
    try {
      let allTargets = await fetchAllRows('happycall_targets', '*', 'target_date');
      let visible = (allTargets || []).filter(t => !t.is_skipped);
      if (mode === 'mine') {
        visible = visible.filter(t => {
          if (t.temporary_assignee) return t.temporary_assignee === user.name;
          return t.assigned_employee === user.name;
        });
      }
      if (mode === 'store') visible = visible.filter(t => t.assigned_store === user.store_name);
      const allLogs = await fetchAllRows('happycall_logs', '*', 'checked_at');
      const customers = await fetchAllRows('customers', '*', 'open_date');
      setCustomersByJoinNo(Object.fromEntries((customers || []).map(c => [c.join_no, c])));
      setTargets(visible);
      setLogs(allLogs || []);
    } catch (e) {
      alert('해피콜 리스트 조회 오류: ' + e.message);
    }
  }

  const latestLogByTarget = useMemo(() => {
    const map = {};
    logs.forEach(l => {
      const prev = map[l.target_id];
      if (!prev || String(l.checked_at || '') > String(prev.checked_at || '')) map[l.target_id] = l;
    });
    return map;
  }, [logs]);

  const stats = useMemo(() => calculateCallStats(targets, latestLogByTarget), [targets, latestLogByTarget]);

  const storeOptions = useMemo(() => ['전체', ...Array.from(new Set(targets.map(t => t.assigned_store).filter(Boolean))).sort((a,b)=>String(a).localeCompare(String(b), 'ko'))], [targets]);
  const employeeOptions = useMemo(() => {
    let base = targets;
    if (storeFilter !== '전체') base = base.filter(t => t.assigned_store === storeFilter);
    return ['전체', ...Array.from(new Set(base.map(t => t.assigned_employee).filter(Boolean))).sort((a,b)=>String(a).localeCompare(String(b), 'ko'))];
  }, [targets, storeFilter]);

  const filteredTargets = useMemo(() => {
    let list = [...targets];
    if (mode === 'all') {
      if (storeFilter !== '전체') list = list.filter(t => t.assigned_store === storeFilter);
      if (employeeFilter !== '전체') list = list.filter(t => t.assigned_employee === employeeFilter || t.temporary_assignee === employeeFilter);
    }
    if (filter === '반려') list = list.filter(t => latestLogByTarget[t.id]?.review_status === '반려');
    else if (filter === '경과미완료') list = list.filter(t => !latestLogByTarget[t.id] && diffDays(t.target_date) > 0);
    else if (filter === '오늘신규') list = list.filter(t => t.target_date === todayLocalISO());
    else if (filter === '미완료전체') list = list.filter(t => !latestLogByTarget[t.id] || latestLogByTarget[t.id]?.review_status === '반려');
    else if (filter === '완료') list = list.filter(t => latestLogByTarget[t.id] && latestLogByTarget[t.id]?.review_status !== '반려');
    return list.sort((a,b)=>sortTargetsByPriority(a,b,latestLogByTarget));
  }, [targets, latestLogByTarget, filter, mode, storeFilter, employeeFilter]);

  const title = mode === 'mine' ? '내 해피콜 리스트' : mode === 'store' ? `${user.store_name} 해피콜 진행현황` : '전체 해피콜 리스트';

  return (
    <div>
      <h2>{title}</h2>
      <div className="stats">
        <Card title="전체 대상" value={stats.total} />
        <Card title="전체 완료율" value={`${stats.rate}%`} />
        <Card title="오늘 작업 완료율" value={`${stats.todayRate}%`} />
        <Card title="경과 미완료" value={stats.overdue} />
      </div>
      <div className="stats miniStats">
        <Card title="오늘 신규" value={stats.todayTotal} />
        <Card title="오늘 완료" value={stats.todayDone} />
        <Card title="전체 미완료" value={stats.pending} />
        <Card title="반려" value={stats.rejected} />
      </div>
      <div className="filterBar">
        <button className={filter==='미완료전체'?'active':''} onClick={()=>setFilter('미완료전체')}>미완료 전체 {stats.pending}</button>
        <button className={filter==='반려'?'active rejected':''} onClick={()=>setFilter('반려')}>반려 {stats.rejected}</button>
        <button className={filter==='경과미완료'?'active':''} onClick={()=>setFilter('경과미완료')}>경과 미완료 {stats.overdue}</button>
        <button className={filter==='오늘신규'?'active':''} onClick={()=>setFilter('오늘신규')}>오늘 신규 {stats.todayTotal}</button>
        <button className={filter==='완료'?'active':''} onClick={()=>setFilter('완료')}>완료 {stats.done}</button>
        <button className={filter==='전체'?'active':''} onClick={()=>setFilter('전체')}>전체 {stats.total}</button>
        {mode === 'mine' && (user.role === '관리자' || user.role === '점장') && <button className="blueActionBtn" onClick={()=>setBulkTempOpen(true)}>임시 배정 하기</button>}
      </div>
      {mode === 'all' && (
        <div className="sectionCard allCallFilterBox">
          <select value={storeFilter} onChange={e => { setStoreFilter(e.target.value); setEmployeeFilter('전체'); }}>
            {storeOptions.map(v => <option key={v}>{v}</option>)}
          </select>
          <select value={employeeFilter} onChange={e => setEmployeeFilter(e.target.value)}>
            {employeeOptions.map(v => <option key={v}>{v}</option>)}
          </select>
          <button onClick={() => { setStoreFilter('전체'); setEmployeeFilter('전체'); }}>필터 초기화</button>
        </div>
      )}
      <div className="list">
        {filteredTargets.map(t => {
          const log = latestLogByTarget[t.id];
          return (
            <div className="callItem" key={t.id} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })}>
              <div>
                <b>{formatCustomerJoinNo(t.join_no, customersByJoinNo, t.customer_name)}</b>
                <p>{t.assigned_store} · {t.temporary_assignee ? `${t.assigned_employee} → 임시 ${t.temporary_assignee}` : t.assigned_employee} · {callTypeLabel(t.call_type)}</p>
                <p className="muted">대상일 {t.target_date} / {t.skip_reason || t.assign_reason || ''}</p>
                {log?.review_status === '반려' && <p className="rejectReason">반려사유: {log.review_memo || '반려 사유 없음'}</p>}
              </div>
              {log?.review_status === '반려' ? <span className="badge rejected">반려</span> : <StatusBadge target={t} log={log} />}
            </div>
          );
        })}
      </div>
      {selected && <CallModal target={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} readOnly={readOnly} />}
      {bulkTempOpen && <BulkTempAssignModal user={user} targets={targets} latestLogByTarget={latestLogByTarget} onClose={()=>setBulkTempOpen(false)} onSaved={load} />}
    </div>
  );
}

function callTypeLabel(type) {
  return ({
    MONTHLY_DAY: '월간 정기',
    D_PLUS_1: 'D+1',
    D_PLUS_7: 'D+7',
    D_PLUS_13: 'D+13',
    D_PLUS_95: 'D+95',
    D_PLUS_185: 'D+185'
  })[type] || type;
}


function BulkTempAssignModal({ user, targets, latestLogByTarget, onClose, onSaved }) {
  const [employees, setEmployees] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [assignee, setAssignee] = useState('');
  const [typeFilter, setTypeFilter] = useState('전체');
  const [stateFilter, setStateFilter] = useState('전체');
  const [busy, setBusy] = useState(false);

  useEffect(() => { loadEmployees(); }, []);

  async function loadEmployees() {
    const { data, error } = await supabase.from('employees').select('*').eq('status', '재직').order('name');
    if (error) return alert('직원 목록 조회 오류: ' + error.message);
    setEmployees(data || []);
  }

  const staffOptions = useMemo(() => (employees || [])
    .filter(e => e.store_name === user.store_name && e.name !== user.name)
    .sort((a,b)=>String(a.name).localeCompare(String(b.name), 'ko')), [employees, user.store_name, user.name]);

  const list = useMemo(() => {
    return (targets || []).filter(t => {
      if (t.assigned_store !== user.store_name) return false;
      if (!isD95D185Type(t.call_type)) return false;
      const log = latestLogByTarget[t.id];
      const isDone = log && log.review_status !== '반려';
      const isRejected = log?.review_status === '반려';
      if (isDone) return false;
      if (stateFilter === '미완료' && log) return false;
      if (stateFilter === '반려' && !isRejected) return false;
      if (typeFilter !== '전체' && callTypeLabel(t.call_type) !== typeFilter) return false;
      return true;
    }).sort((a,b)=>String(a.target_date || '').localeCompare(String(b.target_date || '')) || String(a.assigned_employee || '').localeCompare(String(b.assigned_employee || ''), 'ko'));
  }, [targets, latestLogByTarget, user.store_name, typeFilter, stateFilter]);

  function toggle(id) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function saveBulk() {
    if (!assignee) return alert('임시 배정할 직원을 선택해주세요.');
    if (!selectedIds.length) return alert('임시 배정할 대상을 선택해주세요.');
    if (!confirm(`선택한 ${selectedIds.length}건을 이번 1회만 ${assignee}에게 임시 배정할까요?`)) return;
    setBusy(true);
    try {
      const now = new Date().toISOString();
      for (const id of selectedIds) {
        const { error } = await supabase.from('happycall_targets').update({
          temporary_assignee: assignee,
          temporary_assignee_store: user.store_name,
          temporary_assigned_by: user.name,
          temporary_assigned_at: now,
          temporary_assign_reason: 'D+95/D+185 일괄 임시 배정'
        }).eq('id', id);
        if (error) throw error;
      }
      await writeAuditLog('임시처리자일괄변경', 'happycall_targets', user.store_name, user, `D+95/D+185 ${selectedIds.length}건 → ${assignee}`);
      alert(`임시 배정 완료: ${selectedIds.length}건`);
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '내 해피콜', actionName: 'D+95/D+185 일괄 임시 배정', error: e });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalBg">
      <div className="modal bulkTempModal">
        <div className="modalHead"><h2>D+95 / D+185 임시 배정</h2><button onClick={onClose}>닫기</button></div>
        <section>
          <div className="bulkTempToolbar">
            <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}><option>전체</option><option>D+95</option><option>D+185</option></select>
            <select value={stateFilter} onChange={e=>setStateFilter(e.target.value)}><option>전체</option><option>미완료</option><option>반려</option></select>
            <select value={assignee} onChange={e=>setAssignee(e.target.value)}><option value="">임시 처리자 선택</option>{staffOptions.map(e => <option key={e.id || e.name} value={e.name}>{e.name}</option>)}</select>
            <button onClick={()=>setSelectedIds(list.map(t => t.id))}>전체 선택</button>
            <button onClick={()=>setSelectedIds([])}>선택 해제</button>
            <button className="primary" disabled={busy} onClick={saveBulk}>임시 배정 저장</button>
          </div>
          <p className="muted">내 매장의 D+95/D+185 중 미완료 또는 반려 건만 표시됩니다. 대상일이 지난 미완료 건도 포함됩니다.</p>
          <p className="muted">표시 {list.length}건 / 선택 {selectedIds.length}건</p>
        </section>
        <section>
          <table>
            <thead><tr><th>선택</th><th>가입번호</th><th>유형</th><th>대상일</th><th>원 담당자</th><th>현재 임시</th><th>상태</th></tr></thead>
            <tbody>
              {list.map(t => {
                const log = latestLogByTarget[t.id];
                return <tr key={t.id}>
                  <td><input type="checkbox" checked={selectedIds.includes(t.id)} onChange={()=>toggle(t.id)} /></td>
                  <td>{t.join_no}</td><td>{callTypeLabel(t.call_type)}</td><td>{t.target_date}</td><td>{t.assigned_employee}</td><td>{t.temporary_assignee || '-'}</td><td>{log?.review_status === '반려' ? '반려' : '미완료'}</td>
                </tr>;
              })}
              {!list.length && <tr><td colSpan="7" className="muted">임시 배정 가능한 D+95/D+185 건이 없습니다.</td></tr>}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}


function CallHistoryList({ targetId }) {
  const [logs, setLogs] = useState([]);

  useEffect(() => { load(); }, [targetId]);

  async function load() {
    const { data, error } = await supabase
      .from('happycall_logs')
      .select('*')
      .eq('target_id', targetId)
      .order('checked_at', { ascending: true })
      .order('id', { ascending: true });
    if (!error) setLogs(data || []);
  }

  if (!logs.length) return <p className="muted">처리 이력이 없습니다.</p>;

  return (
    <div className="historyTimeline">
      {logs.map((log, idx) => (
        <div className="historyStep" key={log.id || idx}>
          <h4>{idx + 1}차 저장내용</h4>
          <p><b>저장일시</b> {formatKST(log.checked_at)}</p>
          <p><b>처리자</b> {log.employee_name || log.checked_by || '-'}</p>
          <p><b>결과</b> {log.call_result} / {log.call_detail}</p>
          {log.memo && <p><b>메모</b> {log.memo}</p>}
          {hasMinorInfo(log) && (
            <p><b>미성년자 정보</b> {isActiveMinor(log.minor_birth_date) ? '미성년자' : '생일 경과/확인 필요'} / 생년월일 {log.minor_birth_date || '-'} / 법정대리인 {log.legal_rep_join_no || '-'}</p>
          )}
          {log.review_status === '반려' && (
            <div className="historyReject">
              <h4>{idx + 1}차 반려내용</h4>
              <p><b>반려사유</b> {log.review_memo || '반려 사유 없음'}</p>
              {log.reviewed_by && <p><b>검수자</b> {log.reviewed_by}</p>}
              {log.reviewed_at && <p><b>반려일시</b> {formatKST(log.reviewed_at)}</p>}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function CallModal({ target, user, onClose, onSaved, readOnly = false }) {
  const [result, setResult] = useState('통화 완료');
  const [detail, setDetail] = useState('');
  const [memo, setMemo] = useState('');
  const [legalRepJoinNo, setLegalRepJoinNo] = useState('');
  const [isMinorChecked, setIsMinorChecked] = useState(false);
  const [minorBirthDate, setMinorBirthDate] = useState('');
  const [history, setHistory] = useState([]);
  const [editJoinNoOpen, setEditJoinNoOpen] = useState(false);
  const [newJoinNo, setNewJoinNo] = useState(target.join_no || '');
  const [joinNoReason, setJoinNoReason] = useState('');

  const rejectedInfo = useMemo(() => {
    return history.find(h => h.review_status === '반려');
  }, [history]);
  const [script, setScript] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [tempAssignee, setTempAssignee] = useState(target.temporary_assignee || '');
  const [tempBusy, setTempBusy] = useState(false);
  const latestLog = target.latestLog || null;

  useEffect(() => { loadDetail(); }, [target.id]);
  useEffect(() => {
    if (latestLog?.is_minor || latestLog?.minor_birth_date || target.minor_birth_date || latestLog?.legal_rep_join_no || target.legal_rep_join_no) {
      setIsMinorChecked(true);
      setLegalRepJoinNo(latestLog?.legal_rep_join_no || target.legal_rep_join_no || '');
      setMinorBirthDate(latestLog?.minor_birth_date || target.minor_birth_date || '');
    }
  }, [target.id]);

  async function loadDetail() {
    const { data: h } = await supabase.from('customers').select('*').eq('join_no', target.join_no).order('open_date', { ascending: false });
    setHistory(h || []);
    const { data: s } = await supabase.from('call_scripts').select('*').eq('call_type', target.call_type).maybeSingle();
    setScript(s);
    const { data: e } = await supabase.from('employees').select('*').eq('status', '재직').order('name');
    setEmployees(e || []);
  }

  function onResultChange(v) {
    setResult(v);
    setDetail('');
    // 결과 변경 시 미성년자 정보 유지;
  }

  
  const canTempAssign = (user.role === '관리자' || user.role === '점장') && isD95D185Type(target.call_type);

  const tempAssigneeOptions = useMemo(() => {
    return (employees || [])
      .filter(e => e.store_name === target.assigned_store && e.name !== user.name)
      .sort((a,b)=>String(a.name).localeCompare(String(b.name), 'ko'));
  }, [employees, target.assigned_store, user.name]);

  async function saveTempAssignee() {
    if (!canTempAssign) return alert('D+95 / D+185 건만 임시 처리자 변경이 가능합니다.');
    if (!tempAssignee) return alert('임시 처리자를 선택해주세요.');
    if (!confirm(`${target.join_no} 건을 이번 1회만 ${tempAssignee}에게 임시 배정할까요?`)) return;

    setTempBusy(true);
    try {
      const { error } = await supabase.from('happycall_targets').update({
        temporary_assignee: tempAssignee,
        temporary_assignee_store: target.assigned_store,
        temporary_assigned_by: user.name,
        temporary_assigned_at: new Date().toISOString(),
        temporary_assign_reason: 'D+95/D+185 임시 처리자 변경'
      }).eq('id', target.id);
      if (error) throw error;

      await writeAuditLog('임시처리자변경', 'happycall_target', target.id, user, `${target.join_no} / ${target.assigned_employee} → ${tempAssignee}`);
      alert('임시 처리자가 변경되었습니다.');
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '해피콜 상세', actionName: '임시 처리자 변경', joinNo: target.join_no, error: e });
    } finally {
      setTempBusy(false);
    }
  }


  async function saveJoinNoChange() {
    if (user.role !== '관리자') return alert('관리자만 가입번호를 수정할 수 있습니다.');
    if (!confirm(`가입번호를 ${target.join_no} → ${newJoinNo} 로 수정할까요? 관련 이력이 모두 변경됩니다.`)) return;

    try {
      await updateJoinNoEverywhere({
        oldJoinNo: target.join_no,
        newJoinNo,
        reason: joinNoReason,
        user
      });
      alert('가입번호가 수정되었습니다.');
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '해피콜 상세', actionName: '가입번호 수정', joinNo: target.join_no, error: e });
    }
  }

async function save() {
    if (!detail) {
      alert('상세 결과를 선택해주세요.');
      return;
    }

    if (detail === '불만사항있음' && !memo.trim()) {
      alert('불만 사항 있음은 메모가 필요합니다.');
      return;
    }

    if (detail === '고객사정' && !memo.trim()) {
      alert('고객사정 선택 시 메모를 입력해야 합니다.');
      return;
    }

    if (detail === '사고 발생건' && !memo.trim()) {
      alert('사고 발생건 선택 시 메모를 입력해야 합니다.');
      return;
    }

    if (isMinorChecked) {
      if (!isValidLegalRepJoinNo(legalRepJoinNo)) {
        alert('법정대리인 가입번호는 10자리 또는 12자리만 입력 가능합니다.');
        return;
      }
      if (!minorBirthDate) {
        alert('미성년자 생년월일을 입력해야 합니다.');
        return;
      }
    }

    try {
      const payload = {
        target_id: target.id,
        join_no: target.join_no,
        employee_name: user.name,
        call_result: result,
        call_detail: detail,
        memo,
        checked_by: user.name,
        review_status: '검수대기',
        legal_rep_join_no: isMinorChecked ? legalRepJoinNo.trim() : null,
        is_minor: isMinorChecked,
        minor_birth_date: isMinorChecked ? minorBirthDate : null
      };

      let saveError = null;
      const existingPending = latestLog && (latestLog.review_status || '검수대기') === '검수대기' ? latestLog : null;
      if (existingPending) {
        const { error } = await supabase.from('happycall_logs').update({
          ...payload,
          checked_at: new Date().toISOString()
        }).eq('id', existingPending.id);
        saveError = error;
      } else {
        const { error } = await supabase.from('happycall_logs').insert({
          ...payload,
          parent_log_id: latestLog?.review_status === '반려' ? latestLog.id : null,
          review_round: latestLog?.review_status === '반려' ? (Number(latestLog.review_round || 1) + 1) : 1
        });
        saveError = error;
      }
      if (saveError) throw saveError;

      if (shouldExcludeUnavailable(detail)) {
        await supabase.from('refused_customers').upsert({
          join_no: target.join_no,
          target_id: target.id,
          refused_by: user.name,
          refused_at: new Date().toISOString(),
          memo: memo || detail || '통화 불가',
          legal_rep_join_no: null
        }, { onConflict: 'join_no' });

        await supabase.from('happycall_targets')
          .update({ is_skipped: true, skip_reason: `통화 불가 처리: ${detail}` })
          .eq('join_no', target.join_no)
          .neq('id', target.id)
          .is('is_skipped', false)
          .not('call_type', 'in', '(D+95,D+185,d95,d185,D95,D185)');
      } else {
        await supabase.from('refused_customers').delete().eq('join_no', target.join_no);
      }

      if (typeof rejectedInfo !== 'undefined' && rejectedInfo?.id) {
        await supabase.from('happycall_logs').update({
          review_status: '재처리완료'
        }).eq('id', rejectedInfo.id);
      }

      if (detail === '불만사항있음') {
        await supabase.from('voc_logs').insert({
          target_id: target.id,
          join_no: target.join_no,
          customer_issue: memo,
          status: '미처리'
        });
      }

      await writeAuditLog('해피콜저장', 'happycall_target', target.id, user, `${target.join_no} / ${result} / ${detail}`);
      alert('저장되었습니다. 검수 대기 상태로 등록되었습니다.');
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '해피콜 상세', actionName: '해피콜 저장', joinNo: target.join_no, error: e });
    }
  }

  return (
    <div className="modalBg">
      <div className="modal">
        <div className="modalHead"><h2>해피콜 상세</h2><div className="modalHeadBtns">{user.role === "관리자" && <button onClick={()=>setEditJoinNoOpen(!editJoinNoOpen)}>가입번호 수정</button>}<button onClick={onClose}>닫기</button></div></div>
        {editJoinNoOpen && user.role === '관리자' && (
          <section className="joinNoEditBox">
            <h3>가입번호 수정</h3>
            <input value={newJoinNo} onChange={e=>setNewJoinNo(e.target.value)} placeholder="새 가입번호 입력" />
            <textarea value={joinNoReason} onChange={e=>setJoinNoReason(e.target.value)} placeholder="수정사유 입력 필수" />
            <button className="primary" onClick={saveJoinNoChange}>가입번호 수정 저장</button>
            <p className="muted">customers / targets / logs / refused / assignment 이력이 함께 변경됩니다.</p>
          </section>
        )}
        <section>
          <h3>고객 기본정보</h3>
          <div className="infoGrid">
            <p><b>가입번호</b><br />{target.customer_name ? `${target.customer_name} (${target.join_no})` : target.join_no}</p>
            <p><b>대상일</b><br />{target.target_date}</p>
            {hasMinorInfo(latestLog || target) && <p><b>미성년자</b><br />{isActiveMinor(latestLog?.minor_birth_date || target.minor_birth_date) ? '예' : '생일 경과/확인 필요'}</p>}
            {(latestLog?.minor_birth_date || target.minor_birth_date) && <p><b>미성년자 생년월일</b><br />{latestLog?.minor_birth_date || target.minor_birth_date}</p>}
            {(latestLog?.legal_rep_join_no || target.legal_rep_join_no) && <p><b>법정대리인 가입번호</b><br />{latestLog?.legal_rep_join_no || target.legal_rep_join_no}</p>}
            <p><b>유형</b><br />{callTypeLabel(target.call_type)}</p>
            <p><b>담당자</b><br />{target.assigned_employee}</p>
          </div>
        </section>
        <section><h3>배정 사유</h3><p className="reason">{target.assign_reason || target.skip_reason || '배정 사유 없음'}</p></section>
        {canTempAssign && (
          <section>
            <h3>D+95 / D+185 임시 처리자 변경</h3>
            <div className="tempAssignBox">
              <select value={tempAssignee} onChange={e=>setTempAssignee(e.target.value)}>
                <option value="">같은 매장 직원 선택</option>
                {tempAssigneeOptions.map(e => <option key={e.id || e.name} value={e.name}>{e.name}</option>)}
              </select>
              <button className="primary" disabled={tempBusy} onClick={saveTempAssignee}>임시 배정 저장</button>
            </div>
            <p className="muted">이번 리스트업 건만 1회성으로 변경되며, 원래 담당자와 향후 배정 기준은 변경되지 않습니다.</p>
          </section>
        )}
        {script && <section><h3>연락 스크립트</h3><div className="script"><b>{script.title}</b><p>{script.script}</p></div></section>}
        <section>
          <h3>고객 개통 이력</h3>
          <div className="history">
            {history.length ? history.map(h => <div key={h.id}><b>{h.open_date}</b> · {h.store_name} · {h.seller_name}</div>) : <p className="muted">개통 이력이 없습니다.</p>}
          </div>
        </section>
        {rejectedInfo && (
          <section className="rejectBox">
            <h3>검수 반려됨</h3>
            <p>{rejectedInfo.review_memo || '반려 사유 없음'}</p>
            <p className="muted">내용을 보완해서 다시 저장하면 검수대기로 재등록됩니다.</p>
          </section>
        )}

        <section className="callHistoryBox"><h3>처리 이력</h3><CallHistoryList targetId={target.id} /></section>

        <section>
          <h3>통화 결과</h3>
          {readOnly ? (
            <p className="muted">점장 확인 화면에서는 수정할 수 없습니다. 직원 본인만 내 해피콜 탭에서 결과를 입력할 수 있습니다.</p>
          ) : (
            <>
              <div className="resultMinorRow">
                <select className={`callResultSelect compact ${result === '통화 완료' || result === '통화완료' ? 'success' : result === '부재중' ? 'warning' : result === '통화 불가' ? 'danger' : ''}`} value={result} onChange={e => onResultChange(e.target.value)}>
                  {Object.keys(CALL_RESULTS).map(v => <option key={v} className={v === '통화 완료' || v === '통화완료' ? 'optionSuccess' : v === '부재중' ? 'optionWarning' : v === '통화 불가' ? 'optionDanger' : ''}>{v}</option>)}
                </select>
                <label className="minorCheckLabel"><input type="checkbox" checked={isMinorChecked} onChange={e=>setIsMinorChecked(e.target.checked)} /> 미성년자</label>
              </div>
              <div className="callResultLegend">
                <span className="success">통화 완료</span>
                <span className="warning">부재중</span>
                <span className="danger">통화 불가</span>
              </div>
              <select value={detail} onChange={e => setDetail(e.target.value)}>
                <option value="">상세 결과 선택</option>
                {CALL_RESULTS[result].map(v => <option key={v}>{v}</option>)}
              </select>
              {isMinorChecked && (
                <div className="minorInfoBox">
                  <div className="minorInputGroup">
                    <label className="minorFieldLabel">* 법정대리인 가입번호 입력</label>
                    <input value={legalRepJoinNo} onChange={e => setLegalRepJoinNo(e.target.value.replace(/\D/g, ''))} className="requiredInput" placeholder="법정대리인 가입번호 입력" />
                    <p className="fieldHelpText">해당 칸에 작성 필수 · 10자리 또는 12자리만 저장 가능</p>
                  </div>
                  <div className="minorInputGroup">
                    <label className="minorFieldLabel">* 미성년자 생년월일 입력</label>
                    <input type="date" value={minorBirthDate} onChange={e => setMinorBirthDate(e.target.value)} className="requiredInput" />
                    
                  </div>
                </div>
              )}
              <textarea className={detail === '불만사항있음' || detail === '고객사정' || detail === '사고 발생건' ? 'requiredInput' : ''} value={memo} onChange={e => setMemo(e.target.value)} placeholder={detail === '불만사항있음' || detail === '고객사정' || detail === '사고 발생건' ? '작성 필수 · 메모 입력' : '메모 입력'} />
              <button className="primary" onClick={save}>저장</button>
            </>
          )}
        </section>
      </div>
    </div>
  );
}



function ReviewStorePermissionsModal({ employee, stores, user, onClose }) {
  const [allowed, setAllowed] = useState(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, [employee.id]);

  async function load() {
    const { data, error } = await supabase
      .from('reviewer_store_permissions')
      .select('*')
      .eq('employee_id', employee.id);

    if (error) return alert('검수매장 조회 오류: ' + error.message);
    setAllowed(new Set((data || []).map(r => r.store_name)));
  }

  function toggle(storeName) {
    setAllowed(prev => {
      const next = new Set(prev);
      if (next.has(storeName)) next.delete(storeName);
      else next.add(storeName);
      return next;
    });
  }

  async function save() {
    setBusy(true);
    try {
      const { error: delError } = await supabase
        .from('reviewer_store_permissions')
        .delete()
        .eq('employee_id', employee.id);
      if (delError) throw delError;

      const rows = Array.from(allowed).map(storeName => ({
        employee_id: employee.id,
        employee_name: employee.name,
        store_name: storeName
      }));

      if (rows.length) {
        const { error: insError } = await supabase.from('reviewer_store_permissions').insert(rows);
        if (insError) throw insError;
      }

      await writeAuditLog('검수매장설정', 'reviewer_store_permissions', employee.id, user, `${employee.name} / ${rows.map(r => r.store_name).join(', ') || '없음'}`);
      alert('검수 매장 권한이 저장되었습니다.');
      onClose();
    } catch (e) {
      alert('검수매장 저장 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  const storeList = (stores || []).filter(s => s.name !== '관리자' && s.status !== '폐점');

  return (
    <div className="modalBg">
      <div className="modal reviewStoreModal">
        <div className="modalHead"><h2>{employee.name} 검수 매장 설정</h2><button onClick={onClose}>닫기</button></div>
        <p className="muted">선택한 매장 건만 해당 검수자 검수 화면에 표시됩니다.</p>
        <div className="storePermissionGrid">
          {storeList.map(s => (
            <label key={s.id || s.name} className={allowed.has(s.name) ? 'storePermission active' : 'storePermission'}>
              <input type="checkbox" checked={allowed.has(s.name)} onChange={() => toggle(s.name)} />
              <span>{s.name}</span>
            </label>
          ))}
        </div>
        <button className="primary" onClick={save} disabled={busy}>검수 매장 저장</button>
      </div>
    </div>
  );
}

function Employees({ user }) {
  const [rows, setRows] = useState([]);
  const [storeOptions, setStoreOptions] = useState([]);
  const [form, setForm] = useState({ name:'', store_name:'금촌', status:'재직', password:'1234', role:'직원', hire_date:'', resign_date:'' });
  const [viewStatus, setViewStatus] = useState('재직');
  const [drafts, setDrafts] = useState({});
  const [detailTarget, setDetailTarget] = useState(null);
  const [reviewStoreTarget, setReviewStoreTarget] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    const [{ data: empData, error: empError }, { data: storeData, error: storeError }] = await Promise.all([
      supabase.from('employees').select('*').order('name'),
      supabase.from('stores').select('*').order('name')
    ]);

    if (empError) alert(empError.message);
    if (storeError) alert(storeError.message);

    const stores = [{ id: 'admin-option', name: '관리자', status: '관리용' }, ...(storeData || [])];
    setRows(empData || []);
    setStoreOptions(stores);

    const nextDrafts = {};
    (empData || []).forEach(r => {
      nextDrafts[r.id] = {
        store_name: r.store_name || '',
        status: r.status || '재직',
        role: r.role || '직원',
        password: r.password || ''
      };
    });
    setDrafts(nextDrafts);

    if (stores.length && !stores.some(s => s.name === form.store_name)) {
      setForm(prev => ({ ...prev, store_name: stores[0].name }));
    }
  }

  function setDraft(id, patch) {
    setDrafts(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }

  async function add() {
    if (!form.name.trim()) return alert('직원명을 입력해주세요.');
    if (!form.store_name) return alert('매장을 선택해주세요.');

    const payload = {
      name: form.name,
      store_name: form.store_name,
      status: form.status,
      password: form.password || '1234',
      role: form.role,
      hire_date: form.hire_date || null,
      resign_date: form.status === '퇴사' ? (form.resign_date || null) : null
    };

    const { error } = await supabase.from('employees').insert(payload);
    if (error) return alert(error.message);

    await writeAuditLog('직원추가', 'employee', form.name, user, `${form.name} / ${form.store_name} / ${form.role}`);
    setForm({ name:'', store_name: storeOptions[0]?.name || '금촌', status:'재직', password:'1234', role:'직원', hire_date:'', resign_date:'' });
    load();
  }

  async function resetPassword(employee) {
    if (!confirm(`${employee.name} 직원의 비밀번호를 1234로 초기화할까요?`)) return;

    const { error } = await supabase.from('employees').update({ password: '1234' }).eq('id', employee.id);
    if (error) return alert(error.message);

    await writeAuditLog('비밀번호초기화', 'employee', employee.id, user, `대상: ${employee.name} / 1234 초기화`);
    alert(`${employee.name} 비밀번호가 1234로 초기화되었습니다.`);
    load();
  }

  async function saveEmployee(employee) {
    const d = drafts[employee.id] || {};
    const patch = {
      store_name: d.store_name || employee.store_name || '',
      status: d.status || employee.status || '재직',
      role: d.role || employee.role || '직원'
    };

    if (d.password && d.password !== employee.password) patch.password = d.password;
    if (patch.status === '퇴사' && !employee.resign_date) patch.resign_date = todayLocalISO();

    if (!confirm(`${employee.name} 직원 정보를 최종 저장할까요?`)) return;

    const { error } = await supabase.from('employees').update(patch).eq('id', employee.id);
    if (error) return alert(error.message);

    const detailParts = [formatAuditPatch(patch)];
    if (d.password && d.password !== employee.password) detailParts.push('비밀번호: 변경됨');
    await writeAuditLog('직원최종저장', 'employee', employee.id, user, `대상: ${employee.name} / ${detailParts.join(' / ')}`);
    alert(`${employee.name} 직원 정보가 저장되었습니다.`);
    load();
  }

  const storeSelect = (value, onChange) => (
    <select value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">매장 선택</option>
      {storeOptions.map(s => (
        <option key={s.id || s.name} value={s.name}>
          {s.name}{s.status === '폐점' ? ' (폐점)' : s.status === '관리용' ? ' (자동배정 제외)' : ''}
        </option>
      ))}
    </select>
  );

  const filteredRows = rows.filter(r => (r.status || '재직') === viewStatus);
  const activeCount = rows.filter(r => (r.status || '재직') === '재직').length;
  const retiredCount = rows.filter(r => r.status === '퇴사').length;

  return (
    <div>
      <h2>직원관리</h2>

      <div className="filterBar">
        <button className={viewStatus==='재직'?'active':''} onClick={()=>setViewStatus('재직')}>재직중 {activeCount}</button>
        <button className={viewStatus==='퇴사'?'active':''} onClick={()=>setViewStatus('퇴사')}>퇴사자 {retiredCount}</button>
      </div>

      <div className="formGrid employeeAddGrid">
        <input placeholder="직원명" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />
        {storeSelect(form.store_name, v => setForm({...form,store_name:v}))}
        <select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>
          <option>재직</option>
          <option>퇴사</option>
          <option>리스트 제외</option>
        </select>
        <select className="historyRoleSelect" value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>
          <option>직원</option>
          <option>점장</option>
          <option>검수자</option>
          <option>관리자</option>
        </select>
        <input placeholder="초기 비밀번호" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} />
        <button className="primary" onClick={add}>직원 추가</button>
      </div>

      <div className="sectionCard employeeTableWrap">
        <table className="employeeTable compactEmployeeTable">
          <thead>
            <tr>
              <th>이름</th>
              <th>매장</th>
              <th>상태</th>
              <th>권한</th>
              <th>비밀번호 관리</th>
              <th>상세</th>
              <th>검수매장</th>
              <th>최종저장</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(r => {
              const d = drafts[r.id] || {};
              return (
                <tr key={r.id}>
                  <td className="employeeNameCell">{r.name}</td>
                  <td>{storeSelect(d.store_name ?? r.store_name, v => setDraft(r.id,{store_name:v}))}</td>
                  <td>
                    <select value={d.status ?? r.status ?? '재직'} onChange={e=>setDraft(r.id,{status:e.target.value})}>
                      <option>재직</option>
                      <option>퇴사</option>
                      <option>리스트 제외</option>
                    </select>
                  </td>
                  <td>
                    <select value={d.role ?? r.role ?? '직원'} onChange={e=>setDraft(r.id,{role:e.target.value})}>
                      <option>직원</option>
                      <option>점장</option>
                      <option>검수자</option>
                      <option>관리자</option>
                    </select>
                  </td>
                  <td>
                    <div className="passwordEdit">
                      <input value={d.password ?? r.password ?? ''} onChange={e=>setDraft(r.id,{password:e.target.value})} placeholder="비밀번호" disabled={r.status === '퇴사'} />
                      <button onClick={() => resetPassword(r)} disabled={r.status === '퇴사'}>비밀번호 초기화</button>
                    </div>
                  </td>
                  <td><button onClick={()=>setDetailTarget(r)}>상세</button></td>
                  <td>{(d.role ?? r.role) === '검수자' || (d.role ?? r.role) === '관리자' ? <button onClick={()=>setReviewStoreTarget(r)}>설정</button> : <span className="muted">-</span>}</td>
                  <td><button className="primary" onClick={()=>saveEmployee(r)}>최종저장</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="muted">입사일, 퇴사일, 근무이력은 상세 버튼에서 관리합니다. 퇴사자는 로그인할 수 없습니다.</p>
      {storeOptions.length <= 1 && <p className="error">운영 매장 목록이 없습니다. 먼저 매장관리에서 매장을 등록해주세요.</p>}
      {detailTarget && <EmployeeDetailModal employee={detailTarget} stores={storeOptions} user={user} onClose={()=>setDetailTarget(null)} onUpdated={load} />}
      {reviewStoreTarget && <ReviewStorePermissionsModal employee={reviewStoreTarget} stores={storeOptions} user={user} onClose={()=>setReviewStoreTarget(null)} />}
    </div>
  );
}

function EmployeeDetailModal({ employee, stores, user, onClose, onUpdated }) {
  const [profile, setProfile] = useState({
    hire_date: employee.hire_date || '',
    resign_date: employee.resign_date || ''
  });

  async function saveProfile() {
    const patch = {
      hire_date: profile.hire_date || null,
      resign_date: profile.resign_date || null
    };

    const { error } = await supabase.from('employees').update(patch).eq('id', employee.id);
    if (error) return alert(error.message);

    await writeAuditLog('직원상세저장', 'employee', employee.id, user, `대상: ${employee.name} / 입사일: ${patch.hire_date || '-'} / 퇴사일: ${patch.resign_date || '-'}`);
    alert('상세 정보가 저장되었습니다.');
    onUpdated?.();
  }

  return (
    <div className="modalBg">
      <div className="modal employeeDetailModal">
        <div className="modalHead"><h2>{employee.name} 상세관리</h2><button onClick={onClose}>닫기</button></div>

        <section>
          <h3>입사/퇴사 정보</h3>
          <div className="formGrid compact">
            <label>입사일<input className="dateInputWide" type="date" value={profile.hire_date} onChange={e=>setProfile({...profile,hire_date:e.target.value})} /></label>
            <label>퇴사일<input className="dateInputWide" type="date" value={profile.resign_date} onChange={e=>setProfile({...profile,resign_date:e.target.value})} /></label>
            <button className="primary detailSaveBtn" onClick={saveProfile}>상세 저장</button>
          </div>
          <p className="muted">퇴사 상태는 직원관리 메인에서 상태를 퇴사로 바꾼 뒤 최종저장하세요.</p>
        </section>

        <WorkHistoryInner employee={employee} stores={stores} user={user} />
      </div>
    </div>
  );
}

function WorkHistoryInner({ employee, stores, user }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ store_name: employee.store_name || '', role: employee.role || '직원', start_date: '', end_date: '' });
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState(null);

  useEffect(() => { load(); }, [employee.id]);

  async function load() {
    const { data, error } = await supabase
      .from('employee_store_history')
      .select('*')
      .eq('employee_id', employee.id)
      .order('start_date', { ascending: false });

    if (error) alert('근무이력 조회 오류: ' + error.message);
    setRows(data || []);
  }

  function resetForm() {
    setEditingId(null);
    setForm({ store_name: employee.store_name || '', role: employee.role || '직원', start_date: '', end_date: '' });
  }

  async function saveHistory() {
    if (!form.store_name) return alert('매장을 선택해주세요.');
    if (!form.role) return alert('직책을 선택해주세요.');
    if (!form.start_date) return alert('시작일을 입력해주세요.');

    setBusy(true);
    try {
      const payload = {
        employee_id: employee.id,
        employee_name: employee.name,
        store_name: form.store_name,
        role: form.role,
        start_date: form.start_date,
        end_date: form.end_date || null
      };

      if (editingId) {
        const { error } = await supabase.from('employee_store_history').update(payload).eq('id', editingId);
        if (error) throw error;
        await writeAuditLog('근무이력수정', 'employee_store_history', editingId, user, `${employee.name} / ${form.store_name} / ${form.role} / ${form.start_date} ~ ${form.end_date || '현재'}`);
      } else {
        const { error } = await supabase.from('employee_store_history').insert(payload);
        if (error) throw error;
        await writeAuditLog('근무이력추가', 'employee_store_history', employee.id, user, `${employee.name} / ${form.store_name} / ${form.role} / ${form.start_date} ~ ${form.end_date || '현재'}`);
      }

      resetForm();
      load();
    } catch (e) {
      alert('근무이력 저장 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  function editHistory(row) {
    setEditingId(row.id);
    setForm({
      store_name: row.store_name || '',
      role: row.role || '직원',
      start_date: row.start_date || '',
      end_date: row.end_date || ''
    });
  }

  async function deleteHistory(row) {
    if (!confirm('이 근무이력을 삭제할까요?')) return;

    const { error } = await supabase.from('employee_store_history').delete().eq('id', row.id);
    if (error) return alert(error.message);

    await writeAuditLog('근무이력삭제', 'employee_store_history', row.id, user, `${employee.name} / ${row.store_name} / ${row.role} / ${row.start_date} ~ ${row.end_date || '현재'}`);
    if (editingId === row.id) resetForm();
    load();
  }

  return (
    <section>
      <h3>근무이력</h3>
      <div className="historyFormSingle">
        <select className="historyStoreSelect" value={form.store_name} onChange={e=>setForm({...form,store_name:e.target.value})}>
          <option value="">매장 선택</option>
          {stores.filter(s => s.name !== '관리자').map(s => <option key={s.id || s.name} value={s.name}>{s.name}</option>)}
        </select>
        <select className="historyRoleSelect" value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>
          <option>직원</option>
          <option>점장</option>
          <option>검수자</option>
          <option>관리자</option>
        </select>
        <input className="historyDateInput" type="date" value={form.start_date} onChange={e=>setForm({...form,start_date:e.target.value})} />
        <span className="dateTilde">~</span>
        <input className="historyDateInput" type="date" value={form.end_date} onChange={e=>setForm({...form,end_date:e.target.value})} />
        <button className="primary historySaveBtn" onClick={saveHistory} disabled={busy}>{editingId ? '수정 저장' : '이력 추가'}</button>
        {editingId && <button className="historyCancelBtn" onClick={resetForm}>취소</button>}
      </div>
      <p className="muted">종료일을 비워두면 현재 근무중으로 표시됩니다.</p>

      <table className="historyTable">
        <thead><tr><th>매장</th><th>직책</th><th>기간</th><th>관리</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.store_name}</td>
              <td>{r.role}</td>
              <td>{r.start_date} ~ {r.end_date || '현재'}</td>
              <td>
                <div className="historyRowActions">
                  <button onClick={()=>editHistory(r)}>수정</button>
                  <button className="dangerBtn" onClick={()=>deleteHistory(r)}>삭제</button>
                </div>
              </td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan="4" className="muted">등록된 근무이력이 없습니다.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}


function RefusedCustomersViewer() {
  const [rows, setRows] = useState([]);
  const [customersByJoinNo, setCustomersByJoinNo] = useState({});

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const refusedRows = await fetchAllRows('refused_customers', '*', 'refused_at');
      const logs = await fetchAllRows('happycall_logs', '*', 'checked_at');
      const customers = await fetchAllRows('customers', '*', 'open_date');
      setCustomersByJoinNo(Object.fromEntries((customers || []).map(c => [c.join_no, c])));

      const latestByJoinNo = {};
      (logs || []).forEach(l => {
        if (!l.join_no) return;
        const prev = latestByJoinNo[l.join_no];
        if (!prev || String(l.checked_at || '').localeCompare(String(prev.checked_at || '')) > 0) {
          latestByJoinNo[l.join_no] = l;
        }
      });

      const allowedDetails = new Set(['2nd디바이스', '타점 변경', '통신사 이동', '해지', '마케팅 미동의', '고객사정', '사고 발생건']);

      const activeRows = (refusedRows || []).filter(r => {
        const latest = latestByJoinNo[r.join_no];
        if (!latest) return true;
        if (latest.review_status === '반려') return false;
        return latest.call_result === '통화 불가' && allowedDetails.has(latest.call_detail);
      }).map(r => ({
        ...r,
        latestLog: latestByJoinNo[r.join_no] || null
      }));

      setRows(activeRows.sort((a,b)=>String(b.refused_at || '').localeCompare(String(a.refused_at || ''))));
    } catch (e) {
      alert('통화 불가 고객 조회 오류: ' + e.message);
    }
  }

  return (
    <div>
      <h2>통화 불가 고객</h2>
      <div className="sectionCard">
        <table>
          <thead>
            <tr>
              <th>가입번호</th>
              <th>통화불가일시(KST)</th>
              <th>처리자</th>
              <th>사유/메모</th>
              <th>최신처리결과</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id || r.join_no}>
                <td>{formatCustomerJoinNo(r.join_no, customersByJoinNo, r.customer_name)}</td>
                <td>{formatKST(r.refused_at)}</td>
                <td>{r.refused_by || '-'}</td>
                <td>{r.memo || '-'}</td>
                <td>{r.latestLog ? `${r.latestLog.call_result} / ${r.latestLog.call_detail}` : '-'} {hasMinorInfo(r.latestLog || r) && isActiveMinor((r.latestLog || r).minor_birth_date) && <span className="minorBadge">미성년자</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="5" className="muted">통화 불가 고객이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function maskSensitiveAuditDetail(detail) {
  const text = String(detail || '');
  if (!text) return '-';
  if (text.includes('"password"') || text.includes("'password'") || text.toLowerCase().includes('password')) {
    return text.replace(/["']?password["']?\s*:\s*["'][^"']*["']/gi, '비밀번호: 변경됨');
  }
  return text;
}



function SuggestionsPage({ user }) {
  const [rows, setRows] = useState([]);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('기능추가');
  const [content, setContent] = useState('');
  const [statusFilter, setStatusFilter] = useState('전체');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const data = await fetchAllRows('suggestions', '*', 'created_at');
      let list = data || [];
      if (user.role !== '관리자') {
        list = list.filter(r => r.requester_name === user.name);
      }
      setRows(list.sort((a,b)=>String(b.created_at || '').localeCompare(String(a.created_at || ''))));
    } catch (e) {
      askErrorReport({ user, currentTab: '건의/문의', actionName: '건의 목록 조회', error: e });
    }
  }

  async function submitSuggestion() {
    if (!title.trim()) return alert('제목을 입력해주세요.');
    if (!content.trim()) return alert('건의/문의 내용을 입력해주세요.');

    try {
      const { error } = await supabase.from('suggestions').insert({
        requester_name: user.name,
        requester_role: user.role,
        requester_store: user.store_name,
        category,
        title: title.trim(),
        content: content.trim(),
        status: '접수'
      });
      if (error) throw error;

      await writeAuditLog('건의문의등록', 'suggestions', user.name, user, `${category} / ${title}`);
      setTitle('');
      setContent('');
      setCategory('기능추가');
      alert('건의/문의가 등록되었습니다.');
      load();
    } catch (e) {
      askErrorReport({ user, currentTab: '건의/문의', actionName: '건의 등록', error: e });
    }
  }

  async function updateSuggestion(row, patch) {
    try {
      const { error } = await supabase.from('suggestions').update({
        ...patch,
        updated_at: new Date().toISOString()
      }).eq('id', row.id);
      if (error) throw error;
      await writeAuditLog('건의문의수정', 'suggestions', row.id, user, `${row.title} / ${JSON.stringify(patch)}`);
      setSelected(null);
      load();
    } catch (e) {
      askErrorReport({ user, currentTab: '건의/문의', actionName: '건의 상태/코멘트 수정', error: e });
    }
  }

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== '전체' && (r.status || '접수') !== statusFilter) return false;
      if (!q) return true;
      return `${r.requester_name || ''} ${r.requester_store || ''} ${r.category || ''} ${r.title || ''} ${r.content || ''} ${r.admin_comment || ''}`.toLowerCase().includes(q);
    });
  }, [rows, statusFilter, keyword]);

  return (
    <div>
      <h2>{user.role === '관리자' ? '건의/문의 관리' : '건의/문의 사항'}</h2>

      {user.role !== '관리자' && (
        <div className="sectionCard suggestionWriteBox">
          <select value={category} onChange={e=>setCategory(e.target.value)}>
            <option>기능추가</option>
            <option>수정요청</option>
            <option>오류문의</option>
            <option>기타</option>
          </select>
          <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="제목 입력" />
          <textarea value={content} onChange={e=>setContent(e.target.value)} placeholder="건의/문의 내용을 입력해주세요." />
          <button className="primary suggestionSubmitBtn" onClick={submitSuggestion}>건의/문의 등록</button>
        </div>
      )}

      <div className="sectionCard suggestionFilterBox">
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
          <option>전체</option>
          <option>접수</option>
          <option>확인중</option>
          <option>반영예정</option>
          <option>반영완료</option>
          <option>보류</option>
        </select>
        <input value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder={user.role === '관리자' ? '작성자/매장/제목/내용 검색' : '검색'} />
        <button onClick={()=>{setStatusFilter('전체'); setKeyword('');}}>초기화</button>
      </div>

      <div className="sectionCard">
        <table>
          <thead>
            <tr>
              <th>일시</th>
              {user.role === '관리자' && <th>작성자</th>}
              {user.role === '관리자' && <th>매장/권한</th>}
              <th>구분</th>
              <th>제목/내용</th>
              <th>상태</th>
              <th>관리자 코멘트</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.id} className={user.role === '관리자' ? 'clickableRow' : ''} onClick={() => user.role === '관리자' && setSelected(r)}>
                <td>{formatKST(r.created_at)}</td>
                {user.role === '관리자' && <td>{r.requester_name}</td>}
                {user.role === '관리자' && <td>{r.requester_store} / {r.requester_role}</td>}
                <td>{r.category}</td>
                <td className="suggestionContentCell">
                  <b>{r.title}</b>
                  <p>{r.content}</p>
                </td>
                <td>{r.status || '접수'}</td>
                <td className="suggestionCommentCell">
                  <p>{r.admin_comment || '아직 관리자 코멘트가 없습니다.'}</p>
                </td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan={user.role === '관리자' ? 7 : 5} className="muted">건의/문의 내역이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && <SuggestionAdminModal row={selected} onClose={() => setSelected(null)} onSave={updateSuggestion} />}
    </div>
  );
}

function SuggestionAdminModal({ row, onClose, onSave }) {
  const [status, setStatus] = useState(row.status || '접수');
  const [comment, setComment] = useState(row.admin_comment || '');

  return (
    <div className="modalBg">
      <div className="modal suggestionDetailModal">
        <div className="modalHead">
          <h2>건의/문의 상세</h2>
          <button onClick={onClose}>닫기</button>
        </div>

        <section>
          <h3>요청 정보</h3>
          <div className="infoGrid">
            <p><b>등록일</b><br />{formatKST(row.created_at)}</p>
            <p><b>작성자</b><br />{row.requester_store} / {row.requester_name}</p>
            <p><b>권한</b><br />{row.requester_role}</p>
            <p><b>구분</b><br />{row.category}</p>
          </div>
        </section>

        <section>
          <h3>{row.title}</h3>
          <pre className="suggestionFullText">{row.content}</pre>
        </section>

        <section>
          <h3>관리자 처리</h3>
          <select value={status} onChange={e=>setStatus(e.target.value)}>
            <option>접수</option>
            <option>확인중</option>
            <option>반영예정</option>
            <option>반영완료</option>
            <option>보류</option>
          </select>
          <textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder="관리자 코멘트 입력" />
          <button className="primary" onClick={() => onSave(row, { status, admin_comment: comment })}>저장</button>
        </section>
      </div>
    </div>
  );
}



function ErrorReportsViewer({ user }) {
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('전체');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const data = await fetchAllRows('error_reports', '*', 'created_at');
      setRows((data || []).sort((a,b)=>String(b.created_at || '').localeCompare(String(a.created_at || ''))));
    } catch (e) {
      alert('오류보고 조회 오류: ' + e.message);
    }
  }

  async function updateStatus(row, status) {
    const { error } = await supabase.from('error_reports').update({ status }).eq('id', row.id);
    if (error) return alert(error.message);
    await writeAuditLog('오류보고상태변경', 'error_reports', row.id, user, `${row.reporter_name} / ${status}`);
    load();
  }

  const filtered = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== '전체' && (r.status || '접수') !== statusFilter) return false;
      if (!q) return true;
      return `${r.reporter_name || ''} ${r.reporter_role || ''} ${r.reporter_store || ''} ${r.current_tab || ''} ${r.action_name || ''} ${r.join_no || ''} ${r.error_message || ''} ${r.user_agent || ''}`.toLowerCase().includes(q);
    });
  }, [rows, statusFilter, keyword]);

  return (
    <div>
      <h2>오류보고</h2>
      <div className="sectionCard errorFilterBox">
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>
          <option>전체</option>
          <option>접수</option>
          <option>확인중</option>
          <option>해결완료</option>
          <option>보류</option>
        </select>
        <input placeholder="작업자/작업/가입번호/오류 검색" value={keyword} onChange={e=>setKeyword(e.target.value)} />
        <button onClick={() => { setStatusFilter('전체'); setKeyword(''); }}>초기화</button>
      </div>
      <div className="sectionCard">
        <table>
          <thead>
            <tr>
              <th>일시(KST)</th><th>보고자</th><th>권한</th><th>매장</th><th>작업</th><th>가입번호</th><th>오류내용</th><th>상태</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.id}>
                <td>{formatKST(r.created_at)}</td>
                <td>{r.reporter_name}</td>
                <td>{r.reporter_role}</td>
                <td>{r.reporter_store}</td>
                <td>{r.action_name}</td>
                <td>{r.join_no || '-'}</td>
                <td>
                  <button className="errorPreviewBox" onClick={() => setSelected(r)} title="클릭하면 전체 오류내용을 확인합니다.">
                    {r.error_message}
                  </button>
                </td>
                <td>
                  <select value={r.status || '접수'} onChange={e=>updateStatus(r, e.target.value)}>
                    <option>접수</option>
                    <option>확인중</option>
                    <option>해결완료</option>
                    <option>보류</option>
                  </select>
                </td>
              </tr>
            ))}
            {!filtered.length && <tr><td colSpan="8" className="muted">오류보고가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && <ErrorReportDetailModal row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ErrorReportDetailModal({ row, onClose }) {
  const detailText = `오류보고 상세
일시: ${formatKST(row.created_at)}
보고자: ${row.reporter_name || '-'}
권한: ${row.reporter_role || '-'}
매장: ${row.reporter_store || '-'}
화면/탭: ${row.current_tab || '-'}
작업: ${row.action_name || '-'}
가입번호: ${row.join_no || '-'}
상태: ${row.status || '접수'}

오류내용:
${row.error_message || '-'}

브라우저:
${row.user_agent || '-'}`;

  async function copyDetail() {
    try {
      await navigator.clipboard.writeText(detailText);
      alert('오류 상세내용이 복사되었습니다.');
    } catch (e) {
      alert('복사 실패: 직접 드래그해서 복사해주세요.');
    }
  }

  return (
    <div className="modalBg">
      <div className="modal errorDetailModal">
        <div className="modalHead">
          <h2>오류보고 상세</h2>
          <button onClick={onClose}>닫기</button>
        </div>

        <section>
          <h3>작업 상황</h3>
          <div className="infoGrid">
            <p><b>일시</b><br />{formatKST(row.created_at)}</p>
            <p><b>보고자</b><br />{row.reporter_name || '-'}</p>
            <p><b>권한</b><br />{row.reporter_role || '-'}</p>
            <p><b>매장</b><br />{row.reporter_store || '-'}</p>
            <p><b>화면/탭</b><br />{row.current_tab || '-'}</p>
            <p><b>작업</b><br />{row.action_name || '-'}</p>
            <p><b>가입번호</b><br />{row.join_no || '-'}</p>
            <p><b>상태</b><br />{row.status || '접수'}</p>
          </div>
        </section>

        <section>
          <h3>오류내용</h3>
          <pre className="errorFullText">{row.error_message || '-'}</pre>
        </section>

        <section>
          <h3>브라우저 정보</h3>
          <pre className="errorFullText">{row.user_agent || '-'}</pre>
        </section>

        <section>
          <h3>복붙용 전체 내용</h3>
          <textarea className="errorCopyText" readOnly value={detailText} />
          <button className="primary" onClick={copyDetail}>전체 내용 복사</button>
        </section>
      </div>
    </div>
  );
}

function AuditLogsViewer() {
  const [logs, setLogs] = useState([]);
  const [actorFilter, setActorFilter] = useState('전체');
  const [actionFilter, setActionFilter] = useState('전체');
  const [keyword, setKeyword] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const rows = await fetchAllRows('audit_logs', '*', 'created_at');
      setLogs((rows || []).sort((a,b)=>String(b.created_at || '').localeCompare(String(a.created_at || ''))).slice(0, 500));
    } catch (e) {
      alert('감사로그 조회 오류: ' + e.message);
    }
  }

  const actors = useMemo(() => ['전체', ...Array.from(new Set(logs.map(l => l.actor_name).filter(Boolean))).sort((a,b)=>String(a).localeCompare(String(b), 'ko'))], [logs]);
  const actions = useMemo(() => ['전체', ...Array.from(new Set(logs.map(l => l.action).filter(Boolean))).sort((a,b)=>String(a).localeCompare(String(b), 'ko'))], [logs]);

  const filteredLogs = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    return logs.filter(l => {
      if (actorFilter !== '전체' && l.actor_name !== actorFilter) return false;
      if (actionFilter !== '전체' && l.action !== actionFilter) return false;
      if (!q) return true;
      const text = `${l.actor_name || ''} ${l.action || ''} ${l.detail || ''} ${l.target_type || ''} ${l.target_id || ''}`.toLowerCase();
      return text.includes(q);
    });
  }, [logs, actorFilter, actionFilter, keyword]);

  return (
    <div>
      <h2>감사로그</h2>
      <div className="sectionCard auditFilterBox">
        <select value={actorFilter} onChange={e=>setActorFilter(e.target.value)}>
          {actors.map(a => <option key={a}>{a}</option>)}
        </select>
        <select value={actionFilter} onChange={e=>setActionFilter(e.target.value)}>
          {actions.map(a => <option key={a}>{a}</option>)}
        </select>
        <input placeholder="작업내용 검색" value={keyword} onChange={e=>setKeyword(e.target.value)} />
        <button onClick={() => { setActorFilter('전체'); setActionFilter('전체'); setKeyword(''); }}>필터 초기화</button>
      </div>
      <div className="sectionCard">
        <table>
          <thead>
            <tr><th>일시(KST)</th><th>작업자</th><th>작업</th><th>상세</th></tr>
          </thead>
          <tbody>
            {filteredLogs.map(l => (
              <tr key={l.id}>
                <td>{formatKST(l.created_at)}</td>
                <td>{l.actor_name}</td>
                <td>{l.action}</td>
                <td>{maskSensitiveAuditDetail(l.detail || `${l.target_type || ''} ${l.target_id || ''}`)}</td>
              </tr>
            ))}
            {!filteredLogs.length && <tr><td colSpan="4" className="muted">조건에 맞는 감사로그가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function EmployeePerformanceDashboard({ user, mode = 'all' }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);

  useEffect(() => { load(); }, [mode]);

  async function load() {
    try {
      const allTargets = await fetchAllRows('happycall_targets', '*', 'target_date');
      const allLogs = await fetchAllRows('happycall_logs', '*', 'checked_at');

      let visible = (allTargets || []).filter(t => !t.is_skipped);
      if (mode === 'store') visible = visible.filter(t => t.assigned_store === user.store_name);

      setTargets(visible);
      setLogs(allLogs || []);
    } catch (e) {
      alert('직원별 현황 조회 오류: ' + e.message);
    }
  }

  const latestLogByTarget = useMemo(() => {
    const map = {};
    logs.forEach(l => {
      const prev = map[l.target_id];
      if (!prev || String(l.checked_at || '') > String(prev.checked_at || '')) map[l.target_id] = l;
    });
    return map;
  }, [logs]);

  const rows = useMemo(() => {
    const map = {};
    targets.forEach(t => {
      const name = t.assigned_employee || '미지정';
      if (!map[name]) map[name] = {
        name,
        store: t.assigned_store || '',
        total: 0,
        done: 0,
        pending: 0,
        todayTotal: 0,
        todayDone: 0,
        overdue: 0,
        rejected: 0,
        reviewPending: 0,
        reviewDone: 0,
        voc: 0
      };

      const r = map[name];
      const log = latestLogByTarget[t.id];
      r.total += 1;

      if (t.target_date === todayLocalISO()) {
        r.todayTotal += 1;
        if (log) r.todayDone += 1;
      }

      if (log) {
        r.done += 1;
        if ((log.review_status || '검수대기') === '검수대기') r.reviewPending += 1;
        if (log.review_status === '검수완료') r.reviewDone += 1;
        if (log.review_status === '반려') r.rejected += 1;
        if (log.call_detail === '불만사항있음') r.voc += 1;
      } else {
        r.pending += 1;
        if (diffDays(t.target_date) > 0) r.overdue += 1;
      }
    });

    return Object.values(map).sort((a,b) => employeeSortKey(a).localeCompare(employeeSortKey(b), 'ko'));
  
  }, [targets, latestLogByTarget]);

  const total = rows.reduce((a,r)=>({
    total: a.total + r.total,
    done: a.done + r.done,
    pending: a.pending + r.pending,
    overdue: a.overdue + r.overdue,
    rejected: a.rejected + r.rejected
  }), { total:0, done:0, pending:0, overdue:0, rejected:0 });


  function employeeSortKey(row) {
    const order = ['금촌', '야당', '봉일천', '화정', '능곡', '관리직'];
    const store = normalizeLoginStoreName ? normalizeLoginStoreName(row.store, '') : row.store;
    const idx = order.includes(store) ? order.indexOf(store) : 999;
    return `${String(idx).padStart(3,'0')}|${row.store}|${row.name}`;
  }

  async function copyIncompleteRows() {
    const operatingStores = ['금촌', '야당', '봉일천', '화정', '능곡'];
    const storeOrder = { '금촌': 0, '야당': 1, '봉일천': 2, '화정': 3, '능곡': 4 };

    const list = rows
      .filter(r => r.total > 0)
      .filter(r => operatingStores.includes(r.store))
      .filter(r => r.name && r.name !== '배정불가' && !String(r.name).includes('배정불가'))
      .filter(r => Math.round(r.done / r.total * 1000) / 10 < 100)
      .sort((a,b) => {
        const storeDiff = (storeOrder[a.store] ?? 999) - (storeOrder[b.store] ?? 999);
        if (storeDiff !== 0) return storeDiff;
        return String(a.name).localeCompare(String(b.name), 'ko');
      });

    if (!list.length) return alert('이미지로 복사할 미완료자가 없습니다.');

    const sumTotal = list.reduce((a,r)=>a+r.total,0);
    const sumDone = list.reduce((a,r)=>a+r.done,0);
    const rate = sumTotal ? Math.round(sumDone / sumTotal * 1000) / 10 : 0;

    const scale = 2;
    const width = 980;
    const marginX = 44;
    const titleY = 58;
    const dateY = 86;
    const tableTop = 132;
    const headerH = 44;
    const rowH = 48;
    const footerH = 74;
    const bottomPadding = 36;
    const height = tableTop + headerH + (list.length * rowH) + footerH + bottomPadding;

    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);

    function roundRect(x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function ellipsis(text, maxWidth) {
      let t = String(text || '-');
      if (ctx.measureText(t).width <= maxWidth) return t;
      while (t.length > 1 && ctx.measureText(t + '…').width > maxWidth) {
        t = t.slice(0, -1);
      }
      return t + '…';
    }

    ctx.fillStyle = '#f3f4f6';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#ffffff';
    roundRect(18, 18, width - 36, height - 36, 20);
    ctx.fill();

    ctx.fillStyle = '#111827';
    ctx.font = 'bold 28px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText('해피콜 미완료 현황', marginX, titleY);

    const now = new Date();
    const nowText = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    ctx.fillStyle = '#6b7280';
    ctx.font = '14px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`${mode === 'store' ? user.store_name + ' ' : ''}${nowText} 기준`, marginX, dateY);

    const tableX = marginX;
    const tableW = width - (marginX * 2);
    const cols = [
      { label: '인원', x: tableX + 18, w: 190 },
      { label: '매장', x: tableX + 232, w: 126 },
      { label: '대상건', x: tableX + 390, w: 112 },
      { label: '완료건', x: tableX + 530, w: 112 },
      { label: '완료율', x: tableX + 670, w: 140 },
    ];

    ctx.fillStyle = '#111827';
    roundRect(tableX, tableTop, tableW, headerH, 12);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    cols.forEach(c => ctx.fillText(c.label, c.x, tableTop + 28));

    ctx.font = '15px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    list.forEach((r, idx) => {
      const yTop = tableTop + headerH + (idx * rowH);
      const yText = yTop + 30;

      if (idx % 2 === 0) {
        ctx.fillStyle = '#f9fafb';
        roundRect(tableX, yTop + 5, tableW, rowH - 8, 10);
        ctx.fill();
      }

      const rRate = r.total ? Math.round(r.done / r.total * 1000) / 10 : 0;
      ctx.fillStyle = '#111827';
      ctx.font = '15px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(ellipsis(r.name, cols[0].w), cols[0].x, yText);
      ctx.fillText(ellipsis(r.store || '-', cols[1].w), cols[1].x, yText);
      ctx.fillText(`${r.total}건`, cols[2].x, yText);
      ctx.fillText(`${r.done}건`, cols[3].x, yText);

      ctx.fillStyle = rRate >= 80 ? '#166534' : rRate >= 50 ? '#9a3412' : '#991b1b';
      ctx.font = 'bold 15px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(`${rRate}%`, cols[4].x, yText);
    });

    const footerY = tableTop + headerH + (list.length * rowH) + 18;
    ctx.fillStyle = '#eff6ff';
    roundRect(tableX, footerY, tableW, 48, 14);
    ctx.fill();

    ctx.fillStyle = '#1e3a8a';
    ctx.font = 'bold 16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`총 대상 ${sumTotal}건`, tableX + 20, footerY + 31);
    ctx.fillText(`총 완료 ${sumDone}건`, tableX + 190, footerY + 31);
    ctx.fillText(`전체 완료율 ${rate}%`, tableX + 360, footerY + 31);

    canvas.toBlob(async (blob) => {
      if (!blob) return alert('이미지 생성에 실패했습니다.');

      try {
        if (navigator.clipboard && window.ClipboardItem) {
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': blob })
          ]);
          alert('미완료자 현황 이미지가 복사되었습니다.');
          return;
        }
      } catch (e) {}

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `happycall_status_${todayLocalISO()}.png`;
      a.click();
      URL.revokeObjectURL(url);
      alert('브라우저에서 이미지 복사가 제한되어 PNG 파일로 저장했습니다.');
    }, 'image/png');
  }

  return (
    <div>
      <h2>{mode === 'store' ? `${user.store_name} 직원별 해피콜 현황` : '직원별 해피콜 현황'}</h2>
      <button className="primary copyStatusBtn" onClick={copyIncompleteRows}>미완료자 이미지 복사</button>
      <div className="stats">
        <Card title="전체 대상" value={total.total} />
        <Card title="전체 완료율" value={`${total.total ? Math.round(total.done / total.total * 1000) / 10 : 0}%`} />
        <Card title="경과 미완료" value={total.overdue} />
        <Card title="반려" value={total.rejected} />
      </div>

      <div className="sectionCard">
        <table>
          <thead>
            <tr>
              <th>담당자</th><th>매장</th><th>전체</th><th>완료</th><th>완료율</th><th>오늘 작업</th><th>오늘 완료율</th><th>미완료</th><th>경과</th><th>검수대기</th><th>검수완료</th><th>반려</th><th>VOC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.name}>
                <td>{r.name}</td><td>{r.store}</td><td>{r.total}</td><td>{r.done}</td>
                <td>{r.total ? Math.round(r.done/r.total*1000)/10 : 0}%</td>
                <td>{r.todayTotal}</td><td>{r.todayTotal ? Math.round(r.todayDone/r.todayTotal*1000)/10 : 0}%</td>
                <td>{r.pending}</td><td>{r.overdue}</td><td>{r.reviewPending}</td><td>{r.reviewDone}</td><td>{r.rejected}</td><td>{r.voc}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="13" className="muted">표시할 현황이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewDashboard({ user }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [customersByJoinNo, setCustomersByJoinNo] = useState({});
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('검수대기');
  const [employeeFilter, setEmployeeFilter] = useState('전체');
  const [storeFilter, setStoreFilter] = useState('전체');
  const [keyword, setKeyword] = useState('');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const allTargets = await fetchAllRows('happycall_targets', '*', 'target_date');
      const allLogs = await fetchAllRows('happycall_logs', '*', 'checked_at');
      const customers = await fetchAllRows('customers', '*', 'open_date');
      setCustomersByJoinNo(Object.fromEntries((customers || []).map(c => [c.join_no, c])));

      let visibleTargets = (allTargets || []).filter(t => !t.is_skipped);
      if (user.role === '검수자') {
        const { data: permissions, error: permError } = await supabase
          .from('reviewer_store_permissions')
          .select('*')
          .eq('employee_id', user.id);
        if (permError) throw permError;
        const allowedStores = new Set((permissions || []).map(p => p.store_name));
        visibleTargets = visibleTargets.filter(t => allowedStores.has(t.assigned_store));
      }

      setTargets(visibleTargets);
      setLogs(allLogs || []);
    } catch (e) {
      askErrorReport({ user, currentTab: '검수', actionName: '검수 목록 조회', error: e });
    }
  }

  const targetById = useMemo(() => {
    const map = {};
    targets.forEach(t => { map[t.id] = t; });
    return map;
  }, [targets]);

  const baseRows = useMemo(() => {
    const latestByTarget = {};
    logs.forEach(log => {
      const prev = latestByTarget[log.target_id];
      if (!prev || String(log.checked_at || '').localeCompare(String(prev.checked_at || '')) > 0 || (String(log.checked_at || '') === String(prev.checked_at || '') && Number(log.id || 0) > Number(prev.id || 0))) {
        latestByTarget[log.target_id] = log;
      }
    });
    return Object.values(latestByTarget).map(log => ({
      log,
      target: targetById[log.target_id]
    })).filter(r => r.target);
  }, [logs, targetById]);

  const employees = useMemo(() => ['전체', ...Array.from(new Set(baseRows.map(r => r.target.assigned_employee).filter(Boolean))).sort((a,b)=>String(a).localeCompare(String(b), 'ko'))], [baseRows]);
  const stores = useMemo(() => ['전체', ...Array.from(new Set(baseRows.map(r => r.target.assigned_store).filter(Boolean))).sort((a,b)=>String(a).localeCompare(String(b), 'ko'))], [baseRows]);

  const reviewRows = useMemo(() => {
    const q = keyword.trim().toLowerCase();
    let rows = [...baseRows];

    if (filter !== '전체') rows = rows.filter(r => (r.log.review_status || '검수대기') === filter);
    if (employeeFilter !== '전체') rows = rows.filter(r => (r.target.assigned_employee === employeeFilter || r.target.temporary_assignee === employeeFilter));
    if (storeFilter !== '전체') rows = rows.filter(r => r.target.assigned_store === storeFilter);
    if (q) {
      rows = rows.filter(r => `${r.target.join_no || ''} ${getCustomerNameForJoinNo(r.target.join_no, customersByJoinNo)} ${r.target.assigned_employee || ''} ${r.target.assigned_store || ''} ${r.log.call_result || ''} ${r.log.call_detail || ''} ${r.log.memo || ''} ${hasMinorInfo(r.log) ? '미성년자' : ''}`.toLowerCase().includes(q));
    }

    rows.sort((a, b) => String(b.log.checked_at || '').localeCompare(String(a.log.checked_at || '')));
    return rows;
  }, [baseRows, filter, employeeFilter, storeFilter, keyword]);

  const stats = useMemo(() => {
    const total = baseRows.length;
    const pending = baseRows.filter(r => (r.log.review_status || '검수대기') === '검수대기').length;
    const approved = baseRows.filter(r => r.log.review_status === '검수완료').length;
    const rejected = baseRows.filter(r => r.log.review_status === '반려').length;
    return { total, pending, approved, rejected };
  }, [baseRows]);

  return (
    <div>
      <h2>검수</h2>

      <div className="stats">
        <Card title="전체 완료건" value={stats.total} />
        <Card title="검수대기" value={stats.pending} />
        <Card title="검수완료" value={stats.approved} />
        <Card title="반려" value={stats.rejected} />
      </div>

      <div className="filterBar">
        <button className={filter==='검수대기'?'active':''} onClick={()=>setFilter('검수대기')}>검수대기 {stats.pending}</button>
        <button className={filter==='검수완료'?'active':''} onClick={()=>setFilter('검수완료')}>검수완료 {stats.approved}</button>
        <button className={filter==='반려'?'active':''} onClick={()=>setFilter('반려')}>반려 {stats.rejected}</button>
        <button className={filter==='전체'?'active':''} onClick={()=>setFilter('전체')}>전체 {stats.total}</button>
      </div>

      <div className="sectionCard reviewFilterBox">
        <select value={employeeFilter} onChange={e=>setEmployeeFilter(e.target.value)}>
          {employees.map(v => <option key={v}>{v}</option>)}
        </select>
        <select value={storeFilter} onChange={e=>setStoreFilter(e.target.value)}>
          {stores.map(v => <option key={v}>{v}</option>)}
        </select>
        <input placeholder="가입번호/담당자/메모 검색" value={keyword} onChange={e=>setKeyword(e.target.value)} />
        <button onClick={() => { setEmployeeFilter('전체'); setStoreFilter('전체'); setKeyword(''); }}>필터 초기화</button>
      </div>

      <div className="sectionCard">
        <table>
          <thead>
            <tr>
              <th>가입번호</th>
              <th>담당자</th>
              <th>매장</th>
              <th>결과</th>
              <th>메모</th>
              <th>검수상태</th>
              <th>완료일시(KST)</th>
              <th>대상일</th>
            </tr>
          </thead>
          <tbody>
            {reviewRows.map(({log, target}) => (
              <tr key={log.id} className="clickableRow" onClick={()=>setSelected({log, target, allLogs: logs})}>
                <td>{target.join_no}</td>
                <td>{target.assigned_employee}</td>
                <td>{target.assigned_store}</td>
                <td>{log.call_result} / {log.call_detail}</td>
                <td>{log.memo ? '있음' : '-'}</td>
                <td>{log.review_status || '검수대기'}</td>
                <td>{formatKST(log.checked_at)}</td>
                <td>{target.target_date}</td>
              </tr>
            ))}
            {!reviewRows.length && <tr><td colSpan="8" className="muted">조건에 맞는 검수 건이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && <ReviewModal item={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} />}
    </div>
  );
}

function ReviewModal({ item, user, onClose, onSaved }) {
  const { log, target, allLogs = [] } = item;
  const [memo, setMemo] = useState(log.review_memo || '');
  const [busy, setBusy] = useState(false);

  const relatedLogs = useMemo(() => {
    return (allLogs || [])
      .filter(l => l.target_id === log.target_id)
      .sort((a,b)=>String(b.checked_at || '').localeCompare(String(a.checked_at || '')));
  }, [allLogs, log.target_id]);

  const rejectionHistory = relatedLogs.filter(l => l.review_status === '반려' || l.review_memo);

  async function approve() {
    if (!confirm('검수 승인할까요?')) return;

    setBusy(true);
    try {
      const { error } = await supabase.from('happycall_logs').update({
        review_status: '검수완료',
        reviewed_by: user.name,
        reviewed_at: new Date().toISOString(),
        review_memo: memo
      }).eq('id', log.id);

      if (error) throw error;

      await writeAuditLog('검수완료', 'happycall_log', log.id, user, `${target.join_no} / ${target.assigned_employee} / ${log.call_result} / ${log.call_detail}`);
      alert('검수 완료 처리되었습니다.');
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '검수 상세', actionName: '검수 승인', joinNo: target.join_no, error: e });
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!memo.trim()) return alert('반려 사유를 입력해주세요.');
    if (!confirm('이 건을 반려할까요?')) return;

    setBusy(true);
    try {
      const { error } = await supabase.from('happycall_logs').update({
        review_status: '반려',
        reviewed_by: user.name,
        reviewed_at: new Date().toISOString(),
        review_memo: memo
      }).eq('id', log.id);

      if (error) throw error;

      if (isUnavailableCall(log.call_result, log.call_detail)) {
        await supabase.from('refused_customers').delete().eq('join_no', target.join_no);
      }

      await writeAuditLog('검수반려', 'happycall_log', log.id, user, `${target.join_no} / ${target.assigned_employee} / 반려사유: ${memo}`);
      alert('반려 처리되었습니다.');
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '검수 상세', actionName: '검수 반려', joinNo: target.join_no, error: e });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalBg">
      <div className="modal">
        <div className="modalHead">
          <h2>검수 상세</h2>
          <button onClick={onClose}>닫기</button>
        </div>

        <section>
          <h3>기본정보</h3>
          <div className="infoGrid">
            <p><b>가입번호</b><br />{target.join_no}</p>
            <p><b>담당자</b><br />{target.assigned_employee}</p>
            <p><b>매장</b><br />{target.assigned_store}</p>
            <p><b>대상일</b><br />{target.target_date}</p>
            <p><b>완료일시</b><br />{formatKST(log.checked_at)}</p>
            <p><b>검수일시</b><br />{log.reviewed_at ? formatKST(log.reviewed_at) : '-'}</p>
          </div>
        </section>

        <section>
          <h3>직원 입력 결과</h3>
          <p><b>{log.call_result}</b> / {log.call_detail}</p>
          <p className="reason">{log.memo || '메모 없음'}</p>
        </section>

        {rejectionHistory.length > 0 && (
          <section>
            <h3>반려/검수 이력</h3>
            <div className="reviewHistoryList">
              {rejectionHistory.map(h => (
                <div className="reviewHistoryItem" key={h.id}>
                  <b>{h.review_status || '검수대기'}</b>
                  <span>{h.reviewed_at ? formatKST(h.reviewed_at) : formatKST(h.checked_at)}</span>
                  <p>{h.review_memo || h.memo || '메모 없음'}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section>
          <h3>검수 메모 / 반려 사유</h3>
          <textarea value={memo} onChange={e=>setMemo(e.target.value)} placeholder="검수 메모 또는 반려 사유 입력" />
          <div className="reviewActions">
            <button className="primary" disabled={busy} onClick={approve}>검수 승인</button>
            <button className="dangerBtn" disabled={busy} onClick={reject}>반려</button>
          </div>
        </section>
      </div>
    </div>
  );
}

function RawUpload({ user }) {
  const [fileName, setFileName] = useState('');
  const [summary, setSummary] = useState(null);
  const [preview, setPreview] = useState([]);
  const [busy, setBusy] = useState(false);

  function excelDateToISO(value) {
    if (!value) return null;

    if (value instanceof Date && !isNaN(value)) {
      return value.toISOString().slice(0, 10);
    }

    if (typeof value === 'number') {
      const p = XLSX.SSF.parse_date_code(value);
      if (!p) return null;
      return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }

    const text = String(value).trim().replace(/\./g, '-').replace(/\//g, '-');
    const d = new Date(text);
    return isNaN(d) ? null : d.toISOString().slice(0, 10);
  }

  function normalizeStoreName(value) {
    const x = String(value || '').replace(/\s+/g, '').trim();

    if (x.includes('금촌')) return '금촌';
    if (x.includes('야당')) return '야당';
    if (x.includes('봉일천')) return '봉일천';
    if (x.includes('능곡')) return '능곡';
    if (x.includes('화정')) return '화정';
    if (x.includes('고양')) return '고양';
    if (x.includes('합정')) return '합정';
    if (x.includes('지축')) return '지축';

    return String(value || '').trim();
  }

  function latestOnly(rows) {
    const map = new Map();

    rows.forEach(r => {
      if (!r.join_no) return;
      const old = map.get(r.join_no);
      if (!old || String(r.open_date) > String(old.open_date)) {
        map.set(r.join_no, r);
      }
    });

    return Array.from(map.values());
  }

  async function handleFile(file) {
    setBusy(true);
    setSummary(null);
    setPreview([]);
    setFileName(file.name);

    try {
      const data = await file.arrayBuffer();
      const wb = XLSX.read(data, { type: 'array', cellDates: true });

      const sheets = wb.SheetNames.filter(s => /^20\d{2}$/.test(String(s).trim()));
      const rawRows = [];

      sheets.forEach(sheetName => {
        const arr = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });

        arr.forEach((r, idx) => {
          const openDate = excelDateToISO(r[3]);       // D열
          const rawStore = String(r[7] || '').trim();  // H열
          const seller = String(r[9] || '').trim();    // J열
          const customerName = String(r[19] || '').trim(); // T열
          const joinNo = String(r[26] || '').trim();   // AA열

          if (!openDate || !joinNo) return;

          rawRows.push({
            join_no: joinNo,
            customer_name: customerName,
            open_date: openDate,
            store_name: normalizeStoreName(rawStore),
            raw_store_name: rawStore,
            seller_name: seller,
            raw_sheet: String(sheetName),
            raw_row: idx + 1
          });
        });
      });

      const latestRows = latestOnly(rawRows)
        .sort((a, b) => String(b.open_date).localeCompare(String(a.open_date)));

      setSummary({
        sheets: sheets.join(', '),
        rawCount: rawRows.length,
        latestCount: latestRows.length,
        duplicateCount: rawRows.length - latestRows.length,
        rows: latestRows
      });

      setPreview(latestRows.slice(0, 100));
    } catch (e) {
      alert('엑셀 분석 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveCustomers() {
    if (!summary?.rows?.length) {
      alert('먼저 엑셀을 분석해주세요.');
      return;
    }
    if (!confirm(`가입번호 기준으로 ${summary.rows.length}건을 빠르게 저장/업데이트할까요?
기존 고객 ID는 건드리지 않고, 고객 정보만 갱신합니다.`)) {
      return;
    }
    setBusy(true);
    try {
      const cleanRows = summary.rows.map(r => ({
        join_no: r.join_no,
        customer_name: r.customer_name,
        open_date: r.open_date,
        store_name: r.store_name,
        raw_store_name: r.raw_store_name,
        seller_name: r.seller_name,
        raw_sheet: r.raw_sheet,
        raw_row: r.raw_row
      }));
      let saved = 0;
      for (let i = 0; i < cleanRows.length; i += 500) {
        const chunk = cleanRows.slice(i, i + 500);
        const { error } = await supabase
          .from('customers')
          .upsert(chunk, { onConflict: 'join_no', ignoreDuplicates: false });
        if (error) throw error;
        saved += chunk.length;
      }
      await writeAuditLog('RAW저장', 'customers', 'bulk', user, `customers ${saved}건 저장/업데이트`);
      alert(`저장 완료: ${saved}건 저장/업데이트`);
    } catch (e) {
      alert('DB 저장 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>RAW 업로드</h2>
      <LastAuditNotice action="RAW저장" label="마지막 RAW 저장" />

      <div className="uploadBox">
        <p className="muted">엑셀 파일 1개 안의 연도별 시트(2024, 2025, 2026...)를 자동으로 읽습니다.</p>
        <p className="muted">기준 열: D=개통일자 / H=매장명 / J=담당자 / T=고객명 / AA=가입번호</p>

        <input
          type="file"
          accept=".xlsx,.xls"
          onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
        />

        {fileName && <p><b>선택 파일:</b> {fileName}</p>}
        {busy && <p className="muted">처리 중...</p>}

        {summary && (
          <>
            <div className="summaryGrid">
              <Card title="인식 시트" value={summary.sheets || '-'} />
              <Card title="전체 RAW" value={summary.rawCount} />
              <Card title="최신 반영" value={summary.latestCount} />
              <Card title="중복 제외" value={summary.duplicateCount} />
            </div>

            <button className="primary" onClick={saveCustomers} disabled={busy}>
              customers DB 저장
            </button>
          </>
        )}
      </div>

      {preview.length > 0 && (
        <div>
          <h3>미리보기 최신 100건</h3>
          <table>
            <thead>
              <tr>
                <th>가입번호</th>
                <th>고객명</th>
                <th>개통일</th>
                <th>통합매장</th>
                <th>RAW매장</th>
                <th>담당자</th>
                <th>시트</th>
                <th>행</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={`${r.join_no}-${i}`}>
                  <td>{r.join_no}</td>
                  <td>{r.customer_name || '-'}</td>
                  <td>{r.open_date}</td>
                  <td>{r.store_name}</td>
                  <td>{r.raw_store_name}</td>
                  <td>{r.seller_name}</td>
                  <td>{r.raw_sheet}</td>
                  <td>{r.raw_row}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


function Stores({ user }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ name:'', status:'운영중', successor_store:'' });
  useEffect(() => { load(); }, []);
  async function load() { const { data } = await supabase.from('stores').select('*').order('name'); setRows(data || []); }
  async function add() {
    if (!form.name.trim()) return alert('매장명을 입력해주세요.');
    const { error } = await supabase.from('stores').insert(form);
    if (error) return alert(error.message);
    await writeAuditLog('매장추가', 'store', form.name, user, `${form.name} / ${form.status} / ${form.successor_store || ''}`);
    setForm({ name:'', status:'운영중', successor_store:'' });
    load();
  }
  async function update(id, patch) { const { error } = await supabase.from('stores').update(patch).eq('id', id); if (error) alert(error.message); else await writeAuditLog('매장수정', 'store', id, user, formatAuditPatch(patch)); load(); }
  return (
    <div>
      <h2>매장관리</h2>
      <div className="formGrid">
        <input placeholder="매장명" value={form.name} onChange={e=>setForm({...form,name:e.target.value})} />
        <select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}><option>운영중</option><option>폐점</option></select>
        <input placeholder="승계매장" value={form.successor_store||''} onChange={e=>setForm({...form,successor_store:e.target.value})} />
        <button className="primary" onClick={add}>매장 추가</button>
      </div>
      <table><thead><tr><th>매장명</th><th>상태</th><th>승계매장</th></tr></thead>
        <tbody>{rows.map(r => <tr key={r.id}>
          <td>{r.name}</td>
          <td><select value={r.status||'운영중'} onChange={e=>update(r.id,{status:e.target.value})}><option>운영중</option><option>폐점</option></select></td>
          <td><input value={r.successor_store||''} onChange={e=>update(r.id,{successor_store:e.target.value})} /></td>
        </tr>)}</tbody>
      </table>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<ErrorBoundary><App /></ErrorBoundary>);

function resolveAssigneeV8Compact(customer, customers, employees, stores, histories, counter) {
  const normName = v => String(v || '').replace(/\s+/g, '').trim();
  const normStore = v => {
    const x = String(v || '').replace(/\s+/g, '').trim();
    if (x.includes('금촌')) return '금촌';
    if (x.includes('야당')) return '야당';
    if (x.includes('봉일천')) return '봉일천';
    if (x.includes('능곡')) return '능곡';
    if (x.includes('화정')) return '화정';
    if (x.includes('고양')) return '고양';
    if (x.includes('합정')) return '합정';
    if (x.includes('지축')) return '지축';
    return String(v || '').trim();
  };

  const isActive = e => e && e.status === '재직' && e.store_name !== '관리자';
  const findEmp = name => (employees || []).find(e => normName(e.name) === normName(name));

  const baseStore = normStore(customer.store_name || customer.raw_store_name);
  const storeRow = (stores || []).find(s => normStore(s.name) === baseStore);
  let assignStore = storeRow?.status === '폐점' && storeRow?.successor_store ? normStore(storeRow.successor_store) : baseStore;

  if (assignStore === '합정') assignStore = '능곡';
  if (assignStore === '고양') assignStore = '화정';
  if (assignStore === '지축') assignStore = '금촌';

  const prev = (histories || [])
    .filter(h => String(h.join_no) === String(customer.join_no))
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];

  const prevEmp = findEmp(prev?.assigned_employee);
  if (isActive(prevEmp)) {
    return { assigned_employee: prevEmp.name, assigned_store: prevEmp.store_name || assignStore, reason: '이전 배정자 유지' };
  }

  const latestEmp = findEmp(customer.seller_name);
  if (isActive(latestEmp)) {
    return { assigned_employee: latestEmp.name, assigned_store: latestEmp.store_name || assignStore, reason: '최신 개통 담당자 재직' };
  }

  const customerHistory = (customers || [])
    .filter(c => String(c.join_no) === String(customer.join_no))
    .sort((a, b) => String(b.open_date || '').localeCompare(String(a.open_date || '')));

  for (const past of customerHistory) {
    const pastEmp = findEmp(past.seller_name);
    if (isActive(pastEmp)) {
      return { assigned_employee: pastEmp.name, assigned_store: pastEmp.store_name || assignStore, reason: '과거 재직 담당자 승계' };
    }
  }

  const staff = (employees || [])
    .filter(e => isActive(e) && e.role !== '관리자' && normStore(e.store_name) === assignStore)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko'));

  if (staff.length) {
    const idx = counter[assignStore] || 0;
    const picked = staff[idx % staff.length];
    counter[assignStore] = idx + 1;
    return { assigned_employee: picked.name, assigned_store: assignStore, reason: '매장 재직자 순환 배정' };
  }

  return { assigned_employee: '배정불가', assigned_store: assignStore, reason: '재직자 없음' };
}


function normalizeStoreNameForAssignment(v) {
  const x = String(v || '').replace(/\s+/g, '').trim();
  if (x.includes('금촌')) return '금촌';
  if (x.includes('야당')) return '야당';
  if (x.includes('봉일천')) return '봉일천';
  if (x.includes('능곡')) return '능곡';
  if (x.includes('화정')) return '화정';
  if (x.includes('고양')) return '고양';
  if (x.includes('합정')) return '합정';
  if (x.includes('지축')) return '지축';
  return String(v || '').trim();
}

function isD95D185Type(callType) {
  return callType === 'D_PLUS_95' || callType === 'D_PLUS_185';
}

function isActiveEmployee(emp) {
  return emp && emp.status === '재직';
}

function normalizeDateOnly(value) {
  if (!value) return '';
  return String(value).slice(0, 10);
}

function isWithinHistoryDate(historyRow, baseDate) {
  const d = normalizeDateOnly(baseDate);
  const start = normalizeDateOnly(historyRow.start_date);
  const end = normalizeDateOnly(historyRow.end_date);
  if (!d || !start) return false;
  return start <= d && (!end || end >= d);
}

function findCustomerSellerName(customer) {
  return customer.employee_name || customer.staff_name || customer.seller_name || customer.manager_name || customer.employee || customer.staff || customer.rep_name || customer['담당자'] || '';
}

function findCustomerStoreName(customer) {
  return normalizeStoreNameForAssignment(customer.store_name || customer.store || customer.shop_name || customer['매장명'] || '');
}

function findCurrentStoreManager(employees, storeName) {
  const normalizedStore = normalizeStoreNameForAssignment(storeName);
  return (employees || []).find(e =>
    e.status === '재직' &&
    e.role === '점장' &&
    normalizeStoreNameForAssignment(e.store_name) === normalizedStore
  );
}

function findHistoricalManager({ histories, employees, storeName, joinDate }) {
  const normalizedStore = normalizeStoreNameForAssignment(storeName);
  const managerHistories = (histories || [])
    .filter(h =>
      normalizeStoreNameForAssignment(h.store_name) === normalizedStore &&
      h.role === '점장' &&
      isWithinHistoryDate(h, joinDate)
    )
    .sort((a, b) => String(b.start_date || '').localeCompare(String(a.start_date || '')));

  for (const h of managerHistories) {
    const emp = (employees || []).find(e => e.id === h.employee_id || e.name === h.employee_name);
    if (isActiveEmployee(emp)) return { employee: emp, history: h };
  }

  return { employee: null, history: managerHistories[0] || null };
}

function resolveD95D185Assignee({ customer, employees, employeeHistories }) {
  const sellerName = findCustomerSellerName(customer);
  const storeName = findCustomerStoreName(customer);
  const joinDate = customer.open_date || customer.join_date || customer.contract_date || customer.date || customer['개통일자'] || customer['가입일자'] || '';

  const seller = (employees || []).find(e => e.name === sellerName);
  if (isActiveEmployee(seller)) {
    return {
      assigned_store: normalizeStoreNameForAssignment(seller.store_name || storeName),
      assigned_employee: seller.name,
      reason: 'D+95/D+185 재직 판매자 본인 배정'
    };
  }

  const historical = findHistoricalManager({
    histories: employeeHistories,
    employees,
    storeName,
    joinDate
  });

  if (historical.employee) {
    return {
      assigned_store: normalizeStoreNameForAssignment(historical.employee.store_name || storeName),
      assigned_employee: historical.employee.name,
      reason: 'D+95/D+185 퇴사자건 / 개통일 당시 점장 배정'
    };
  }

  const currentManager = findCurrentStoreManager(employees, storeName);
  if (currentManager) {
    return {
      assigned_store: normalizeStoreNameForAssignment(currentManager.store_name || storeName),
      assigned_employee: currentManager.name,
      reason: 'D+95/D+185 퇴사자건 / 현재 매장 점장 배정'
    };
  }

  return {
    assigned_store: storeName,
    assigned_employee: '',
    reason: 'D+95/D+185 퇴사자건 / 배정 가능한 점장 없음'
  };
}





function isValidLegalRepJoinNo(value) {
  const v = String(value || '').replace(/\D/g, '');
  return v.length === 10 || v.length === 12;
}
function ageByBirthDate(birthDate) {
  if (!birthDate) return null;
  const today = new Date();
  const b = new Date(`${birthDate}T00:00:00`);
  if (Number.isNaN(b.getTime())) return null;
  let age = today.getFullYear() - b.getFullYear();
  const m = today.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < b.getDate())) age--;
  return age;
}
function isActiveMinor(birthDate) {
  const age = ageByBirthDate(birthDate);
  return age !== null && age < 19;
}
function hasMinorInfo(row = {}) {
  return !!(row.is_minor || row.minor_birth_date || row.legal_rep_join_no);
}
function getCustomerNameForJoinNo(joinNo, customersByJoinNo = {}) {
  const c = customersByJoinNo?.[joinNo];
  return c?.customer_name || c?.name || c?.customerName || '';
}

function formatCustomerJoinNo(joinNo, customersByJoinNo = {}, fallbackName = '') {
  const name = fallbackName || getCustomerNameForJoinNo(joinNo, customersByJoinNo);
  return name ? `${name} (${joinNo})` : String(joinNo || '-');
}

async function updateJoinNoEverywhere({ oldJoinNo, newJoinNo, reason, user }) {
  const oldNo = String(oldJoinNo || '').trim();
  const newNo = String(newJoinNo || '').trim();
  if (!oldNo || !newNo) throw new Error('가입번호를 입력해주세요.');
  if (oldNo === newNo) throw new Error('기존 가입번호와 동일합니다.');
  if (!reason || !String(reason).trim()) throw new Error('수정사유를 입력해주세요.');

  const { data: existsCustomer } = await supabase.from('customers').select('id').eq('join_no', newNo).limit(1);
  const { data: existsTarget } = await supabase.from('happycall_targets').select('id').eq('join_no', newNo).limit(1);
  if ((existsCustomer || []).length || (existsTarget || []).length) {
    throw new Error('이미 존재하는 가입번호입니다. 수정할 수 없습니다.');
  }

  const tables = ['customers', 'happycall_targets', 'happycall_logs', 'refused_customers', 'assignment_history'];
  for (const table of tables) {
    const { error } = await supabase.from(table).update({ join_no: newNo }).eq('join_no', oldNo);
    if (error) throw error;
  }

  await writeAuditLog('가입번호수정', 'join_no', oldNo, user, `기존 ${oldNo} → 변경 ${newNo} / 사유: ${reason}`);
}
function dedupeHappycallTargets(rows) {
  const map = new Map();
  const duplicates = [];
  const priority = {
    'D_PLUS_1': 1,
    'D_PLUS_7': 2,
    'D_PLUS_13': 3,
    'D_PLUS_95': 4,
    'D_PLUS_185': 5,
    'MONTHLY_DAY': 9
  };

  (rows || []).forEach(row => {
    const key = `${row.join_no}|${row.target_date}`;
    const current = map.get(key);

    if (!current) {
      map.set(key, row);
      return;
    }

    duplicates.push({ key, kept: current, removed: row });

    const currentRank = priority[current.call_type] ?? 99;
    const rowRank = priority[row.call_type] ?? 99;

    if (rowRank < currentRank) {
      map.set(key, row);
    }
  });

  return {
    rows: Array.from(map.values()),
    duplicates
  };
}


function isSameOddEvenMonth(openDate, targetDate) {
  const openMonth = Number(String(openDate || '').slice(5, 7));
  const targetMonth = Number(String(targetDate || '').slice(5, 7));
  if (!openMonth || !targetMonth) return true;
  return openMonth % 2 === targetMonth % 2;
}

function TargetGenerator({ user }) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const [targetDate, setTargetDate] = useState(todayISO);
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState(null);
  const [preview, setPreview] = useState([]);

  function ymd(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(dateText, days) {
    const d = new Date(dateText + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return ymd(d);
  }

  function targetMonth(dateText) {
    return dateText.slice(0, 7);
  }

  function dayOfMonth(dateText) {
    return Number(dateText.slice(8, 10));
  }

  function normalizeName(v) {
    return String(v || '').replace(/\s+/g, '').trim();
  }

  function normalizeStore(v) {
    const x = String(v || '').replace(/\s+/g, '').trim();
    if (x.includes('금촌')) return '금촌';
    if (x.includes('야당')) return '야당';
    if (x.includes('봉일천')) return '봉일천';
    if (x.includes('능곡')) return '능곡';
    if (x.includes('화정')) return '화정';
    if (x.includes('고양')) return '고양';
    if (x.includes('합정')) return '합정';
    if (x.includes('지축')) return '지축';
    return String(v || '').trim();
  }

  function getSuccessorStore(storeName, stores) {
    const s = stores.find(x => normalizeStore(x.name) === normalizeStore(storeName));
    if (s && s.status === '폐점' && s.successor_store) return normalizeStore(s.successor_store);
    if (normalizeStore(storeName) === '합정') return '능곡';
    if (normalizeStore(storeName) === '고양') return '화정';
    if (normalizeStore(storeName) === '지축') return '임지하';
    return normalizeStore(storeName);
  }

  function pickRoundRobin(storeName, staffByStore, counter) {
    const list = staffByStore[storeName] || [];
    if (!list.length) return null;
    const idx = counter[storeName] || 0;
    const picked = list[idx % list.length];
    counter[storeName] = idx + 1;
    return picked;
  }

  function decideAssignment(customer, employees, stores, historyMap, staffByStore, counter, allCustomers = [], histories = []) {
    return resolveAssigneeV8Compact(
      customer,
      allCustomers.length ? allCustomers : [customer],
      employees,
      stores,
      histories,
      counter || {}
    );
  }

  async function generateTargets() {
    setBusy(true);
    setSummary(null);
    setPreview([]);

    try {
      const [customers, employees, stores, histories, employeeHistories, refusedRows] = await Promise.all([
        fetchAllRows('customers', '*', 'open_date'),
        fetchAllRows('employees', '*', 'name'),
        fetchAllRows('stores', '*', 'name'),
        fetchAllRows('assignment_history', '*', 'updated_at'),
        fetchAllRows('employee_store_history', '*', 'start_date'),
        fetchAllRows('refused_customers', '*', 'refused_at')
      ]);

      const activeEmployees = (employees || []).filter(e => e.status === '재직' && e.store_name !== '관리자');
      const staffByStore = {};
      activeEmployees.forEach(e => {
        const st = normalizeStore(e.store_name);
        if (!staffByStore[st]) staffByStore[st] = [];
        staffByStore[st].push(e);
      });
      Object.keys(staffByStore).forEach(k => staffByStore[k].sort((a,b)=>String(a.name).localeCompare(String(b.name), 'ko')));

      const historyMap = {};
      (histories || []).forEach(h => historyMap[h.join_no] = h);

      const refusedMap = Object.fromEntries((refusedRows || []).map(r => [String(r.join_no || ''), r]));

      const plusMap = [
        { days: 1, type: 'D_PLUS_1' },
        { days: 7, type: 'D_PLUS_7' },
        { days: 13, type: 'D_PLUS_13' },
        { days: 95, type: 'D_PLUS_95' },
        { days: 185, type: 'D_PLUS_185' }
      ];

      const targetMonthText = targetMonth(targetDate);
      const targetDay = dayOfMonth(targetDate);

      const rows = [];
      const dPlusJoinNosThisMonth = new Set();

      (customers || []).forEach(c => {
        if (!c.open_date || !c.join_no) return;
        plusMap.forEach(p => {
          if (shouldSkipByRefusedCustomer(c, refusedMap, p.type)) return;
          const plusDate = addDays(c.open_date, p.days);
          const isSaturdayD1MondayCorrection = p.days === 1 && isMondayLocal(targetDate) && isSaturdayLocal(c.open_date) && addDays(c.open_date, 2) === targetDate;
          if (targetMonth(plusDate) === targetMonthText || isSaturdayD1MondayCorrection) {
            dPlusJoinNosThisMonth.add(c.join_no);
          }
          if (plusDate === targetDate || isSaturdayD1MondayCorrection) {
            const a = isD95D185Type(p.type)
              ? resolveD95D185Assignee({ customer: c, employees: employees || [], employeeHistories: employeeHistories || [] })
              : decideAssignment(c, activeEmployees, stores || [], historyMap, staffByStore, {});
            rows.push({
              join_no: c.join_no,
              customer_name: c.customer_name,
              customer_id: c.id,
              target_date: targetDate,
              target_month: targetMonthText,
              call_type: p.type,
              assigned_store: a.assigned_store,
              assigned_employee: a.assigned_employee,
              is_skipped: false,
              skip_reason: isSaturdayD1MondayCorrection ? `토요일 개통 D+1 월요일 보정 / ${a.reason || ''}` : a.reason
            });
          }
        });
      });

      const counter = {};
      (customers || []).forEach(c => {
        if (!c.open_date || !c.join_no) return;
        if (shouldSkipByRefusedCustomer(c, refusedMap, 'MONTHLY_DAY')) return;
        if (dayOfMonth(c.open_date) !== targetDay) return;
        if (!isSameOddEvenMonth(c.open_date, targetDate)) return;
        if (dPlusJoinNosThisMonth.has(c.join_no)) return;

        const a = decideAssignment(c, activeEmployees, stores || [], historyMap, staffByStore, counter);
        rows.push({
          join_no: c.join_no,
          customer_name: c.customer_name,
          customer_id: c.id,
          target_date: targetDate,
          target_month: targetMonthText,
          call_type: 'MONTHLY_DAY',
          assigned_store: a.assigned_store,
          assigned_employee: a.assigned_employee,
          is_skipped: false,
          skip_reason: a.reason
        });
      });

      const deduped = dedupeHappycallTargets(rows);
      const finalRows = deduped.rows;
      if (deduped.duplicates.length) {
        console.warn('중복 해피콜 대상 제거', deduped.duplicates);
      }

      const saveRows = finalRows.filter(r => r.assigned_employee);
      setPreview(finalRows.slice(0, 150));
            // V8 assignment history sync
      for (const t of finalRows) {
        if (t.assigned_employee && t.assigned_employee !== '배정불가') {
          await supabase.from('assignment_history').upsert({
            join_no: t.join_no,
            assigned_employee: t.assigned_employee,
            assigned_store: t.assigned_store,
            updated_at: new Date().toISOString()
          }, { onConflict: 'join_no' });
        }
      }

      setSummary({
        customerCount: customers?.length || 0,
        generated: finalRows.length,
        duplicatedRemoved: deduped.duplicates.length,
        savable: saveRows.length,
        unassigned: finalRows.length - saveRows.length,
        rows: finalRows,
        saveRows
      });
    } catch(e) {
      alert('해피콜 생성 중 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveTargets() {
    if (!summary?.saveRows?.length) return alert('저장할 대상이 없습니다.');

    if (!confirm(`${targetDate} 해피콜 대상 ${summary.saveRows.length}건을 저장할까요?
기존 대상은 삭제하지 않고, 이미 있는 대상은 건너뜁니다.`)) return;

    setBusy(true);

    try {
      const { data: existingRows, error: existingError } = await supabase
        .from('happycall_targets')
        .select('id, join_no, target_date, call_type')
        .eq('target_date', targetDate);

      if (existingError) throw existingError;

      const existingKeys = new Set(
        (existingRows || []).map(r => `${r.join_no}|${r.target_date}|${r.call_type}`)
      );

      const dedupedSave = dedupeHappycallTargets(summary.saveRows);
      const existingLooseKeys = new Set((existingRows || []).map(r => `${r.join_no}|${r.target_date}`));
      const insertRows = dedupedSave.rows.filter(r => {
        const key = `${r.join_no}|${r.target_date}|${r.call_type}`;
        const looseKey = `${r.join_no}|${r.target_date}`;
        return !existingKeys.has(key) && !existingLooseKeys.has(looseKey);
      });

      if (dedupedSave.duplicates.length) {
        await writeAuditLog('해피콜중복제거', 'happycall_targets', targetDate, user, `저장 직전 중복 ${dedupedSave.duplicates.length}건 제거`);
      }

      let saved = 0;

      for (let i = 0; i < insertRows.length; i += 500) {
        const chunk = insertRows.slice(i, i + 500);
        const { error } = await supabase.from('happycall_targets').insert(chunk);
        if (error) throw error;
        saved += chunk.length;
      }

      const historyRows = dedupedSave.rows.map(r => ({
        join_no: r.join_no,
        assigned_store: r.assigned_store,
        assigned_employee: r.assigned_employee,
        assign_reason: r.skip_reason,
        updated_at: new Date().toISOString()
      }));

      for (let i = 0; i < historyRows.length; i += 500) {
        const chunk = historyRows.slice(i, i + 500);
        const { error } = await supabase
          .from('assignment_history')
          .upsert(chunk, { onConflict: 'join_no' });

        if (error) throw error;
      }

      await writeAuditLog('해피콜대상저장', 'happycall_targets', targetDate, user, `${targetDate} 신규 ${saved}건 / 기존 ${summary.saveRows.length - saved}건 건너뜀`);
      alert(`저장 완료: 신규 ${saved}건 / 기존 ${summary.saveRows.length - saved}건 건너뜀`);
    } catch(e) {
      alert('DB 저장 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }


  async function deleteGeneratedTargetsForDate() {
    if (user.role !== '관리자') {
      alert('관리자만 삭제할 수 있습니다.');
      return;
    }

    const { data: existingRows, error: countError } = await supabase
      .from('happycall_targets')
      .select('id, join_no, target_date, call_type')
      .eq('target_date', targetDate);

    if (countError) {
      alert('삭제 대상 조회 오류: ' + countError.message);
      return;
    }

    const count = existingRows?.length || 0;
    if (!count) {
      alert(`${targetDate}에 삭제할 해피콜 대상이 없습니다.`);
      return;
    }

    const confirmText = `${targetDate} 해피콜 대상 ${count}건을 삭제합니다.\n검수/처리 로그가 연결된 대상은 삭제하면 안 될 수 있습니다.\n정말 삭제하려면 아래 입력창에 삭제 라고 입력해주세요.`;
    const input = prompt(confirmText);
    if (input !== '삭제') {
      alert('삭제가 취소되었습니다.');
      return;
    }

    setBusy(true);
    try {
      const targetIds = (existingRows || []).map(r => r.id);

      const { data: logs, error: logError } = await supabase
        .from('happycall_logs')
        .select('target_id')
        .in('target_id', targetIds);

      if (logError) throw logError;

      const loggedIds = new Set((logs || []).map(l => l.target_id));
      const deletableIds = targetIds.filter(id => !loggedIds.has(id));

      if (!deletableIds.length) {
        alert('이미 처리/검수 로그가 연결된 대상만 있어 삭제할 수 없습니다.');
        return;
      }

      const { error } = await supabase
        .from('happycall_targets')
        .delete()
        .in('id', deletableIds);

      if (error) throw error;

      await writeAuditLog('해피콜대상삭제', 'happycall_targets', targetDate, user, `${targetDate} 삭제 ${deletableIds.length}건 / 로그연결 제외 ${count - deletableIds.length}건`);
      alert(`삭제 완료: ${deletableIds.length}건\n로그 연결 제외: ${count - deletableIds.length}건`);
      setSummary(null);
      setPreview([]);
    } catch (e) {
      alert('해피콜 대상 삭제 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>해피콜 생성</h2>
      <LastAuditNotice action="해피콜대상저장" label="마지막 해피콜 대상 저장" />
      {user.role === '관리자' && <button className="dangerBtn" onClick={deleteGeneratedTargetsForDate} disabled={busy}>당일 생성 해피콜 삭제</button>}
      <div className="uploadBox">
        <p className="muted">대상일 기준으로 D+1, D+7, D+13, D+95, D+185와 월간 정기 해피콜을 생성합니다.</p>
        <p className="muted">D+95/D+185는 판매자 재직 시 본인 배정, 판매자 퇴사 시 근무이력 기준 당시 점장 또는 현재 매장 점장에게 배정됩니다.</p>
        <p className="muted">당월 D+ 해피콜이 있는 고객은 해당 월의 월간 정기 해피콜에서 제외됩니다.</p>
        <p className="muted">월 정기 해피콜은 홀수달 개통 고객은 홀수달, 짝수달 개통 고객은 짝수달에만 생성됩니다.</p>
        <p className="muted">일요일 자동 생성은 서버 스케줄러가 KST 오전 9시에 실행하며, 토요일 개통 D+1은 월요일 생성 시 자동 보정됩니다.</p>
        <p className="muted">통화 불가 고객은 이후 해피콜 생성 대상에서 제외됩니다.</p>

        <div className="formGrid compact">
          <input type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
          <button className="primary" onClick={generateTargets} disabled={busy}>대상 계산</button>
          {summary && <button className="primary" onClick={saveTargets} disabled={busy}>해피콜 대상 DB 저장</button>}
        </div>

        {busy && <p className="muted">처리 중...</p>}

        {summary && (
          <div className="summaryGrid">
            <Card title="전체 고객" value={summary.customerCount} />
            <Card title="생성 대상" value={summary.generated} />
            <Card title="저장 가능" value={summary.savable} />
            <Card title="배정불가" value={summary.unassigned} />
          </div>
        )}
      </div>

      {preview.length > 0 && (
        <div>
          <h3>미리보기 최대 150건</h3>
          <table>
            <thead>
              <tr>
                <th>가입번호</th>
                <th>대상일</th>
                <th>유형</th>
                <th>배정매장</th>
                <th>담당자</th>
                <th>배정사유</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={`${r.join_no}-${r.call_type}-${i}`}>
                  <td>{r.customer_name ? `${r.customer_name} (${r.join_no})` : r.join_no}</td>
                  <td>{r.target_date}</td>
                  <td>{callTypeLabel(r.call_type)}</td>
                  <td>{r.assigned_store}</td>
                  <td>{r.assigned_employee || '배정불가'}</td>
                  <td>{r.skip_reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


function ManagerStoreDashboard({ user }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selected, setSelected] = useState(null);
  useEffect(() => { load(); }, []);
  async function load() {
    try {
      const allTargets = await fetchAllRows('happycall_targets', '*', 'target_date');
      const allLogs = await fetchAllRows('happycall_logs', '*', 'checked_at');
      setTargets((allTargets || []).filter(t => !t.is_skipped && t.assigned_store === user.store_name));
      setLogs(allLogs || []);
    } catch (e) {
      alert('매장 현황 조회 오류: ' + e.message);
    }
  }
  const latestLogByTarget = useMemo(() => {
    const map = {};
    logs.forEach(l => { if (!map[l.target_id]) map[l.target_id] = l; });
    return map;
  }, [logs]);
  const stats = useMemo(() => {
    const total = targets.length;
    const done = targets.filter(t => latestLogByTarget[t.id]).length;
    const voc = targets.filter(t => latestLogByTarget[t.id]?.call_detail === '불만사항있음').length;
    const absent = targets.filter(t => latestLogByTarget[t.id]?.call_result === '부재중').length;
    const rejected = targets.filter(t => isUnavailableCall(latestLogByTarget[t.id]?.call_result, latestLogByTarget[t.id]?.call_detail)).length;
    return { total, done, pending: total - done, voc, absent, rejected, rate: total ? Math.round(done / total * 1000) / 10 : 0 };
  }, [targets, latestLogByTarget]);
  const byEmployee = useMemo(() => {
    const map = {};
    targets.forEach(t => {
      const k = t.assigned_employee || '미지정';
      if (!map[k]) map[k] = { name: k, total: 0, done: 0, voc: 0 };
      map[k].total++;
      const log = latestLogByTarget[t.id];
      if (log) map[k].done++;
      if (log?.call_detail === '불만사항있음') map[k].voc++;
    });
    return Object.values(map).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko'));
  }, [targets, latestLogByTarget]);
  return (
    <div>
      <h2>{user.store_name} 해피콜 현황</h2>
      <div className="stats">
        <Card title="전체 대상" value={stats.total} />
        <Card title="완료" value={stats.done} />
        <Card title="미완료" value={stats.pending} />
        <Card title="완료율" value={`${stats.rate}%`} />
      </div>
      <div className="stats miniStats">
        <Card title="VOC" value={stats.voc} />
        <Card title="부재중" value={stats.absent} />
        <Card title="통화거부" value={stats.rejected} />
        <Card title="담당자 수" value={byEmployee.length} />
      </div>
      <div className="sectionCard">
        <h3>직원별 진행률</h3>
        <table><thead><tr><th>담당자</th><th>전체</th><th>완료</th><th>미완료</th><th>완료율</th><th>VOC</th></tr></thead>
        <tbody>{byEmployee.map(r => <tr key={r.name}><td>{r.name}</td><td>{r.total}</td><td>{r.done}</td><td>{r.total-r.done}</td><td>{r.total ? Math.round(r.done/r.total*1000)/10 : 0}%</td><td>{r.voc}</td></tr>)}</tbody></table>
      </div>
      <div className="sectionCard">
        <h3>매장 해피콜 리스트</h3>
        <table><thead><tr><th>가입번호</th><th>법정대리인</th><th>담당자</th><th>유형</th><th>대상일</th><th>상태</th><th>결과</th></tr></thead>
        <tbody>{targets.map(t => { const log = latestLogByTarget[t.id]; return <tr key={t.id} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })} className="clickableRow"><td>{t.join_no}</td><td>{t.assigned_employee}</td><td>{callTypeLabel(t.call_type)}</td><td>{t.target_date}</td><td>{log ? '완료' : '미완료'}</td><td>{log ? `${log.call_result} / ${log.call_detail}` : '-'}</td></tr> })}</tbody></table>
      </div>
      {selected && <CallModal target={selected} user={user} onClose={() => setSelected(null)} onSaved={load} readOnly={true} />}
    </div>
  );
}




function ManagerStoreDashboardV6({ user }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('미완료전체');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const allTargets = await fetchAllRows('happycall_targets', '*', 'target_date');
      const allLogs = await fetchAllRows('happycall_logs', '*', 'checked_at');
      setTargets((allTargets || []).filter(t => !t.is_skipped && t.assigned_store === user.store_name));
      setLogs(allLogs || []);
    } catch (e) {
      alert('매장 현황 조회 오류: ' + e.message);
    }
  }

  const latestLogByTarget = useMemo(() => {
    const map = {};
    logs.forEach(l => { if (!map[l.target_id]) map[l.target_id] = l; });
    return map;
  }, [logs]);

  const stats = useMemo(() => calculateCallStats(targets, latestLogByTarget), [targets, latestLogByTarget]);

  const byEmployee = useMemo(() => {
    const map = {};
    targets.forEach(t => {
      const k = t.assigned_employee || '미지정';
      if (!map[k]) map[k] = { name:k,total:0,done:0,todayTotal:0,todayDone:0,overdue:0,voc:0 };
      map[k].total++;
      const log = latestLogByTarget[t.id];
      if (log) map[k].done++;
      if (t.target_date === todayLocalISO()) {
        map[k].todayTotal++;
        if (log) map[k].todayDone++;
      }
      if (!log && diffDays(t.target_date) > 0) map[k].overdue++;
      if (log?.call_detail === '불만사항있음') map[k].voc++;
    });
    return Object.values(map).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko'));
  }, [targets, latestLogByTarget]);

  const filteredTargets = useMemo(() => {
    let list = [...targets];
    if (filter === '경과미완료') list = list.filter(t => !latestLogByTarget[t.id] && diffDays(t.target_date) > 0);
    else if (filter === '오늘신규') list = list.filter(t => t.target_date === todayLocalISO());
    else if (filter === '미완료전체') list = list.filter(t => !latestLogByTarget[t.id]);
    else if (filter === '완료') list = list.filter(t => latestLogByTarget[t.id]);
    return list.sort((a,b)=>sortTargetsByPriority(a,b,latestLogByTarget));
  }, [targets, latestLogByTarget, filter]);

  return (
    <div>
      <h2>{user.store_name} 해피콜 현황</h2>
      <div className="stats">
        <Card title="전체 대상" value={stats.total} />
        <Card title="전체 완료율" value={`${stats.rate}%`} />
        <Card title="오늘 작업 완료율" value={`${stats.todayRate}%`} />
        <Card title="경과 미완료" value={stats.overdue} />
      </div>
      <div className="stats miniStats">
        <Card title="오늘 신규" value={stats.todayTotal} />
        <Card title="오늘 완료" value={stats.todayDone} />
        <Card title="전체 미완료" value={stats.pending} />
        <Card title="VOC" value={stats.voc} />
      </div>
      <div className="sectionCard">
        <h3>직원별 진행률</h3>
        <table>
          <thead><tr><th>담당자</th><th>전체</th><th>완료</th><th>전체 완료율</th><th>오늘 작업</th><th>오늘 완료율</th><th>경과 미완료</th><th>VOC</th></tr></thead>
          <tbody>
            {byEmployee.map(r => (
              <tr key={r.name}>
                <td>{r.name}</td><td>{r.total}</td><td>{r.done}</td>
                <td>{r.total ? Math.round(r.done/r.total*1000)/10 : 0}%</td>
                <td>{r.todayTotal}</td>
                <td>{r.todayTotal ? Math.round(r.todayDone/r.todayTotal*1000)/10 : 0}%</td>
                <td>{r.overdue}</td><td>{r.voc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sectionCard">
        <h3>매장 해피콜 리스트</h3>
        <div className="filterBar">
          <button className={filter==='미완료전체'?'active':''} onClick={()=>setFilter('미완료전체')}>미완료 전체 {stats.pending}</button>
          <button className={filter==='경과미완료'?'active':''} onClick={()=>setFilter('경과미완료')}>경과 미완료 {stats.overdue}</button>
          <button className={filter==='오늘신규'?'active':''} onClick={()=>setFilter('오늘신규')}>오늘 신규 {stats.todayTotal}</button>
          <button className={filter==='완료'?'active':''} onClick={()=>setFilter('완료')}>완료 {stats.done}</button>
          <button className={filter==='전체'?'active':''} onClick={()=>setFilter('전체')}>전체 {stats.total}</button>
        </div>
        <table>
          <thead><tr><th>가입번호</th><th>담당자</th><th>유형</th><th>대상일</th><th>상태</th><th>결과</th></tr></thead>
          <tbody>
            {filteredTargets.map(t => {
              const log = latestLogByTarget[t.id];
              return (
                <tr key={t.id} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })} className="clickableRow">
                  <td>{t.join_no}</td><td>{t.assigned_employee}</td><td>{callTypeLabel(t.call_type)}</td><td>{t.target_date}</td>
                  <td><StatusBadge target={t} log={log} /></td>
                  <td>{log ? `${log.call_result} / ${log.call_detail}` : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selected && <CallModal target={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} readOnly={true} />}
    </div>
  );
}