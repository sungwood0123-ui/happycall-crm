import React, { Component, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import './styles.css';
import { createClientUuid, runNetworkMutation, runNetworkRead } from './networkMutation.js';
import {
  isActiveEmployeeSession,
  resolveJichukRetiredSellerRule,
  sanitizeStoredEmployee
} from './stage1Rules.js';

const APP_BUILD_VERSION = 'V29.52';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

const pendingErrorReportKeys = new Set();

async function fetchAllRows(tableName, selectText = '*', orderColumn = null) {
  const pageSize = 1000;
  let from = 0;
  let allRows = [];

  while (true) {
    const { data } = await runNetworkRead(() => {
      let query = supabase.from(tableName).select(selectText).range(from, from + pageSize - 1);
      if (orderColumn) query = query.order(orderColumn, { ascending: true });
      return query;
    });

    const rows = data || [];
    allRows = allRows.concat(rows);

    if (rows.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}

async function fetchRowsByIds(tableName, ids, selectText = '*', chunkSize = 100) {
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  const allRows = [];

  const chunks = [];
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    chunks.push(uniqueIds.slice(index, index + chunkSize));
  }
  for (let index = 0; index < chunks.length; index += 4) {
    const groupRows = await Promise.all(chunks.slice(index, index + 4).map(async chunk => {
      const { data } = await runNetworkRead(() => supabase
        .from(tableName)
        .select(selectText)
        .in('id', chunk));
      return data || [];
    }));
    groupRows.forEach(rows => allRows.push(...rows));
  }

  return allRows;
}

async function fetchRowsByValues(tableName, columnName, values, selectText = '*', chunkSize = 100) {
  const uniqueValues = [...new Set((values || []).filter(Boolean))];
  const allRows = [];

  const chunks = [];
  for (let index = 0; index < uniqueValues.length; index += chunkSize) {
    chunks.push(uniqueValues.slice(index, index + chunkSize));
  }
  for (let index = 0; index < chunks.length; index += 4) {
    const groupRows = await Promise.all(chunks.slice(index, index + 4).map(async chunk => {
      const { data } = await runNetworkRead(() => supabase
        .from(tableName)
        .select(selectText)
        .in(columnName, chunk));
      return data || [];
    }));
    groupRows.forEach(rows => allRows.push(...rows));
  }

  return allRows;
}

const HAPPY_CALL_TARGET_LIST_COLUMNS = [
  'id','join_no','customer_id','customer_name','target_date','target_month','call_type',
  'assigned_store','assigned_employee','is_skipped','skip_reason','created_at',
  'temporary_assignee','temporary_assignee_store','temporary_assigned_by','temporary_assigned_at',
  'temporary_assign_reason','legal_rep_join_no','is_minor','minor_birth_date',
  'original_target_date','scheduled_date','scheduled_changed_by','scheduled_changed_at','scheduled_change_reason'
].join(',');

const HAPPY_CALL_LOG_LIST_COLUMNS = [
  'id','target_id','join_no','employee_name','call_result','call_detail','memo','checked_by','checked_at',
  'review_status','reviewed_by','reviewed_at','review_memo','legal_rep_join_no','customer_name',
  'is_minor','minor_birth_date','review_round','parent_log_id'
].join(',');

const CUSTOMER_DISPLAY_COLUMNS = 'id,join_no,customer_name,open_date,store_name,raw_store_name,seller_name';
const REFUSED_CUSTOMER_LIST_COLUMNS = 'id,join_no,target_id,refused_by,refused_at,memo,customer_name,is_minor,minor_birth_date';
const FREEPASS_LEDGER_LIST_COLUMNS = 'id,employee_id,employee_name,employee_store,type,hours,reason,effective_date,created_by,created_at,source_request_id,reset_cycle';
const FREEPASS_REQUEST_LOG_COLUMNS = 'id,employee_name,employee_store,request_type,request_date,hours,reason,status,requested_at,created_at,manager_approved_by,final_approved_by';


const CALL_RESULTS = {
  '통화 완료': ['불만사항없음', '불만사항있음'],
  '부재중': ['카카오톡발송', '문자발송'],
  '통화 불가': ['2nd디바이스', '타점 변경', '통신사 이동', '해지', '마케팅 미동의', '고객사정', '사고 발생건']
};

const D95_D185_RECHECK_UNAVAILABLE_DETAILS = new Set(['고객사정', '마케팅 미동의', '사고 발생건']);

function isUnavailableCall(result) {
  return result === '통화 불가';
}

function shouldExcludeUnavailable(result) {
  return isUnavailableCall(result);
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

function shouldSkipByRefusedCustomer(customer, refusedMap, callType = '', refusedDetailMap = {}) {
  const refused = refusedMap?.[customer.join_no];
  if (!refused) return false;
  if (isNewOpeningAfterRefusal(customer.open_date, refused.refused_at)) return false;
  if (isD95D185Type(callType)) {
    return !D95_D185_RECHECK_UNAVAILABLE_DETAILS.has(refusedDetailMap?.[customer.join_no]);
  }
  return true;
}

function dayOfWeekLocal(dateText) {
  return new Date(`${dateText}T00:00:00`).getDay();
}
function isMondayLocal(dateText) { return dayOfWeekLocal(dateText) === 1; }
function isSaturdayLocal(dateText) { return dayOfWeekLocal(dateText) === 6; }
function addDaysText(dateText, days) {
  const d = new Date(`${dateText}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
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



function applyMobileTableLabels() {
  try {
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
      const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
      if (!headers.length) return;
      table.querySelectorAll('tbody tr').forEach(tr => {
        Array.from(tr.children).forEach((td, idx) => {
          if (!td.getAttribute('data-label') && headers[idx]) td.setAttribute('data-label', headers[idx]);
        });
      });
    });
  } catch (e) {}
}


function useGlobalModalSafety() {
  useEffect(() => {
    let locked = false;
    let savedScrollY = 0;

    const getSafeTop = () => {
      const candidates = [
        document.querySelector('.app header'),
        document.querySelector('.app nav')
      ].filter(Boolean);
      let bottom = 0;
      candidates.forEach((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const isFixedLike = ['fixed', 'sticky'].includes(style.position) && rect.bottom > 0;
        if (isFixedLike) bottom = Math.max(bottom, rect.bottom);
      });
      const maxAllowed = Math.round(window.innerHeight * 0.42);
      return Math.max(12, Math.min(Math.round(bottom + 10), maxAllowed));
    };

    const lockBody = () => {
      if (locked) return;
      locked = true;
      savedScrollY = window.scrollY || window.pageYOffset || 0;
      document.documentElement.classList.add('modal-open');
      document.body.classList.add('modal-open');
      document.body.style.position = 'fixed';
      document.body.style.top = `-${savedScrollY}px`;
      document.body.style.left = '0';
      document.body.style.right = '0';
      document.body.style.width = '100%';
      document.documentElement.style.setProperty('--modal-safe-top', `${getSafeTop()}px`);
    };

    const unlockBody = () => {
      if (!locked) return;
      locked = false;
      document.documentElement.classList.remove('modal-open');
      document.body.classList.remove('modal-open');
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.left = '';
      document.body.style.right = '';
      document.body.style.width = '';
      window.scrollTo(0, savedScrollY);
    };

    const sync = () => {
      const hasModal = Boolean(document.querySelector('.modalBg'));
      if (hasModal) lockBody();
      else unlockBody();
    };

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    sync();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
      unlockBody();
    };
  }, []);
}

function App() {
  useGlobalModalSafety();
  useEffect(() => { applyMobileTableLabels(); });

  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem('happycall_user');
      return saved ? sanitizeStoredEmployee(JSON.parse(saved)) : null;
    } catch {
      localStorage.removeItem('happycall_user');
      return null;
    }
  });
  const [sessionChecking, setSessionChecking] = useState(() => Boolean(user));
  const invalidSessionNotified = useRef(false);

  useEffect(() => {
    if (!user?.id) {
      setSessionChecking(false);
      return undefined;
    }

    let cancelled = false;

    async function validateEmploymentSession() {
      const { data, error } = await supabase
        .from('employees')
        .select('id, name, store_name, status, role, hire_date, resign_date, end_time, happycall_assignment_enabled')
        .eq('id', user.id)
        .maybeSingle();

      if (cancelled) return;
      if (error) {
        console.warn('employee session validation failed', error);
        setSessionChecking(false);
        return;
      }

      if (!isActiveEmployeeSession(data)) {
        localStorage.removeItem('happycall_user');
        setUser(null);
        setSessionChecking(false);
        if (!invalidSessionNotified.current) {
          invalidSessionNotified.current = true;
          alert('퇴사 처리되어 인트라넷 접속이 종료되었습니다.');
        }
        return;
      }

      const safeEmployee = sanitizeStoredEmployee(data);
      localStorage.setItem('happycall_user', JSON.stringify(safeEmployee));
      setUser(safeEmployee);
      setSessionChecking(false);
    }

    const handleFocus = () => validateEmploymentSession();
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') validateEmploymentSession();
    };

    validateEmploymentSession();
    const intervalId = window.setInterval(validateEmploymentSession, 30 * 1000);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [user?.id]);

  if (!supabaseUrl || !supabaseAnonKey) return <EnvMissing />;
  if (sessionChecking) return <div className="page center"><div className="loginCard"><InlineLoadingState label="접속 권한 확인 중" /></div></div>;
  if (!user) return <Login onLogin={setUser} />;

  return (
    <ErrorBoundary>
      <MainApp
        user={user}
        onUserUpdate={(nextUser) => {
          const safeEmployee = sanitizeStoredEmployee(nextUser);
          localStorage.setItem('happycall_user', JSON.stringify(safeEmployee));
          setUser(safeEmployee);
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
        <img className="loginLogo" src="./sechan-logo.png" alt="세찬컴퍼니 로고" onError={e=>{e.currentTarget.style.display='none'}} />
        <h1>세찬컴퍼니 인트라넷</h1>
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

  async function login() {
    setErr('');
    const emp = employees.find(e => e.name === name);
    if (!emp) return setErr('직원을 선택해주세요.');

    const { data: latestEmployee, error } = await supabase
      .from('employees')
      .select('*')
      .eq('id', emp.id)
      .maybeSingle();
    if (error) return setErr('접속 권한을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.');
    if (!isActiveEmployeeSession(latestEmployee)) {
      await loadEmployees();
      return setErr('퇴사 처리된 직원입니다. 관리자에게 문의하세요.');
    }
    if ((latestEmployee.password || '') !== password) return setErr('비밀번호가 맞지 않습니다.');
    const safeEmployee = sanitizeStoredEmployee(latestEmployee);
    localStorage.setItem('happycall_user', JSON.stringify(safeEmployee));
    onLogin(safeEmployee);
  }

  return (
    <div className="page center">
      <div className="loginCard">
        <h1>세찬컴퍼니 인트라넷</h1>
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
    if (next.length < 4) return alert('새 비밀번호는 4자리 이상으로 입력해주세요.');
    if (next !== confirmPw) return alert('새 비밀번호 확인이 일치하지 않습니다.');

    setBusy(true);
    try {
      const { data: latestEmployee, error: lookupError } = await supabase
        .from('employees')
        .select('id, password, status')
        .eq('id', user.id)
        .maybeSingle();
      if (lookupError) throw lookupError;
      if (!isActiveEmployeeSession(latestEmployee)) {
        alert('퇴사 처리된 직원은 비밀번호를 변경할 수 없습니다.');
        return;
      }
      if ((latestEmployee.password || '') !== current) {
        alert('현재 비밀번호가 맞지 않습니다.');
        return;
      }

      const { error } = await supabase.from('employees').update({ password: next }).eq('id', user.id);
      if (error) throw error;

      onUserUpdate(user);
      await writeAuditLog('비밀번호변경', 'employee', user.id, user, `${user.name} 비밀번호 변경`);
      alert('비밀번호가 변경되었습니다.');
      onClose();
    } catch (error) {
      alert('비밀번호 변경 오류: ' + (error?.message || error));
    } finally {
      setBusy(false);
    }
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
  const errorHash = createErrorFingerprint({ currentTab, actionName, joinNo, error });
  const pendingKey = getErrorThrottleKey(errorHash, user?.name);

  if (pendingErrorReportKeys.has(pendingKey)) {
    alert('동일한 오류를 이미 접수 중입니다.');
    return;
  }
  pendingErrorReportKeys.add(pendingKey);

  try {
    // 동일 직원/동일 오류는 1분 이내 재전송 차단
    if (wasErrorReportedWithinOneMinute(errorHash, user?.name)) {
      alert('이미 접수된 오류입니다.\n\n동일 오류는 1분 이내 다시 접수되지 않습니다.');
      return;
    }

    // 같은 오류가 여러 탭에서 동시에 접수돼도 다음 요청을 즉시 차단한다.
    markErrorReportedNow(errorHash, user?.name);

    // 접수 상태의 동일 오류가 있으면 새로 만들지 않고 발생횟수만 증가
    const { data: existing, error: findError } = await supabase
      .from('error_reports')
      .select('*')
      .eq('error_hash', errorHash)
      .eq('status', '접수')
      .order('created_at', { ascending: true })
      .limit(1);

    if (findError && !String(findError.message || '').includes('error_hash')) throw findError;

    if (existing && existing.length) {
      const row = existing[0];
      const nextCount = Number(row.occurrence_count || 1) + 1;
      const { error: updateError } = await supabase
        .from('error_reports')
        .update({
          occurrence_count: nextCount,
          last_occurred_at: new Date().toISOString(),
          last_reporter_name: user?.name || '',
          last_reporter_store: user?.store_name || '',
          last_user_agent: navigator.userAgent
        })
        .eq('id', row.id);

      if (updateError) throw updateError;
      markErrorReportedNow(errorHash, user?.name);
      alert(`이미 접수된 오류입니다.\n\n최초 접수: ${formatKST(row.created_at)}\n현재 상태: ${row.status || '접수'}\n발생횟수: ${nextCount}회`);
      return;
    }

    const payload = {
      reporter_name: user?.name || '',
      reporter_role: user?.role || '',
      reporter_store: user?.store_name || '',
      current_tab: currentTab || '',
      action_name: actionName || '',
      join_no: joinNo || '',
      error_message: message,
      user_agent: navigator.userAgent,
      status: '접수',
      error_hash: errorHash,
      occurrence_count: 1,
      first_occurred_at: new Date().toISOString(),
      last_occurred_at: new Date().toISOString(),
      last_reporter_name: user?.name || '',
      last_reporter_store: user?.store_name || '',
      last_user_agent: navigator.userAgent
    };

    const { error: insertError } = await supabase.from('error_reports').insert(payload);
    if (insertError) {
      // SQL 미반영 상태 호환: 기존 컬럼만으로 저장
      const fallback = {
        reporter_name: payload.reporter_name,
        reporter_role: payload.reporter_role,
        reporter_store: payload.reporter_store,
        current_tab: payload.current_tab,
        action_name: payload.action_name,
        join_no: payload.join_no,
        error_message: payload.error_message,
        user_agent: payload.user_agent,
        status: payload.status
      };
      const { error: fallbackError } = await supabase.from('error_reports').insert(fallback);
      if (fallbackError) throw fallbackError;
    }

    markErrorReportedNow(errorHash, user?.name);
    alert('오류 보고가 접수되었습니다.');
  } catch (e) {
    clearErrorReportedMark(errorHash, user?.name);
    alert('오류 보고 저장 실패: ' + e.message);
  } finally {
    pendingErrorReportKeys.delete(pendingKey);
  }
}



function isPushSupported() {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}
function pushStatusLabel(status) {
  const map = {'점장승인대기':'점장 승인 대기','최종승인대기':'점장 승인 완료 / 최종 승인 대기','최종승인완료':'최종 승인 완료','점장반려':'점장 반려','최종반려':'최종 반려','신청취소':'본인 취소'};
  return map[status] || status || '대기';
}
function pushStatusClass(status) {
  if (status === '최종승인완료') return 'approved';
  if (status === '점장반려' || status === '최종반려' || status === '신청취소') return 'rejected';
  if (status === '최종승인대기') return 'finalWaiting';
  return 'waiting';
}

function isSuperAdmin(user) {
  return user?.role === '최고관리자' || user?.name === '심성우' || user?.email === 'sungwood0123@gmail.com';
}
function isAdminLike(user) {
  return isSuperAdmin(user) || user?.role === '관리자';
}
function isManagerLike(user) {
  return isAdminLike(user) || user?.role === '점장';
}



function maskCustomerName(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  if (s.length === 1) return s;
  if (s.length === 2) return `${s[0]}*`;
  return `${s[0]}${'*'.repeat(Math.max(1, s.length - 2))}${s[s.length - 1]}`;
}

function formatKRW(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0원';
  return `${n.toLocaleString('ko-KR')}원`;
}

function accessoryOrderStatus(row) {
  if (row?.is_returned) return '반품';
  if (row?.customer_received) return '고객 수령';
  if (row?.store_arrived) return '매장 도착';
  if (row?.order_completed) return '주문 완료';
  return '주문 미완료';
}

function accessoryStatusKey(row) {
  if (row?.is_returned) return 'returned';
  if (row?.customer_received) return 'received';
  if (row?.store_arrived) return 'arrived';
  if (row?.order_completed) return 'completed';
  return 'pending';
}

function normalizeAccessoryItems(row) {
  if (Array.isArray(row?.items_json) && row.items_json.length) return row.items_json;
  if (typeof row?.items_json === 'string') {
    try {
      const parsed = JSON.parse(row.items_json);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {}
  }
  return [{ model_name: row?.model_name || '', category: row?.category || '기타', item_name: row?.item_name || '-', price: Number(row?.price || 0) }];
}

function isPendingFreepassRequest(status) {
  return ['점장승인대기','최종승인대기','임시저장'].includes(status);
}

function isEditableFreepassRequest(row) {
  if (!row) return false;
  if (!isPendingFreepassRequest(row.status)) return false;
  return ['사용','월차 전환'].includes(row.request_type);
}

function isCancelableFreepassRequest(row) {
  if (!row) return false;
  return isPendingFreepassRequest(row.status);
}

function pendingDebitHours(rows, employeeName, excludeId = null) {
  return (rows || [])
    .filter(r => r.employee_name === employeeName)
    .filter(r => r.id !== excludeId)
    .filter(r => isPendingFreepassRequest(r.status))
    .filter(r => r.request_type === '사용' || r.request_type === '월차 전환')
    .reduce((sum, r) => sum + Math.abs(Number(r.hours || 0)), 0);
}
function pendingActualUseHoursInMonth(rows, employeeName, ym = todayLocalISO().slice(0,7), excludeId = null) {
  return (rows || [])
    .filter(r => r.employee_name === employeeName)
    .filter(r => r.id !== excludeId)
    .filter(r => isPendingFreepassRequest(r.status))
    .filter(r => r.request_type === '사용')
    .filter(r => String(r.request_date || r.created_at || '').slice(0,7) === ym)
    .reduce((sum, r) => sum + Math.abs(Number(r.hours || 0)), 0);
}

function getBalanceTone(balance) {
  const n = Number(balance || 0);
  if (n < 0) return 'negative';
  if (n === 0) return 'zero';
  return 'positive';
}

async function getFreepassMonthlyLimit() {
  try {
    const { data, error } = await supabase
      .from('system_settings')
      .select('value')
      .eq('key', 'freepass_monthly_limit')
      .maybeSingle();
    if (error) throw error;
    const n = Number(data?.value || 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
  } catch {
    return 10;
  }
}

function normalizeWorkEndTime(value) {
  const raw = String(value || '').trim();
  const m = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '20:00';
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
}
function employeeWorkEndTime(employee) {
  return normalizeWorkEndTime(employee?.end_time || employee?.work_end_time || employee?.default_end_time || '20:00');
}

function parseEvidencePhotos(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {}
  return [{ data: value }];
}


function dateFromCapturedAt(photo, fallback = null) {
  const iso = photo?.captured_at || fallback || new Date().toISOString();
  try {
    const d = new Date(iso);
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return kst.toISOString().slice(0,10);
  } catch {
    return todayLocalISO();
  }
}

function buildEvidencePhotos({ startPhoto, endPhoto, photos }) {
  if (photos && Array.isArray(photos)) return JSON.stringify(photos);
  const arr = [];
  if (startPhoto) arr.push({ type: '출근', ...(typeof startPhoto === 'string' ? { data: startPhoto } : startPhoto) });
  if (endPhoto) arr.push({ type: '퇴근', ...(typeof endPhoto === 'string' ? { data: endPhoto } : endPhoto) });
  return JSON.stringify(arr);
}

function isAccrualRequest(type) {
  return type === '야근 적립' || type === '휴무출근 적립';
}

function isFreepassAccrualType(value) {
  return ['적립','고객 추가 응대','휴무 고객응대','야근 적립','휴무출근 적립','휴무 출근 적립'].includes(value);
}

function freepassActualDateLabel(row) {
  return row?.effective_date || row?.request_date || '-';
}
function freepassRequestedDateTimeLabel(row, requestMap = {}) {
  const sourceId = row?.source_request_id;
  const source = sourceId ? requestMap[sourceId] : null;
  return formatKST(source?.requested_at || source?.created_at || row?.requested_at || row?.created_at);
}
function freepassTypeLabel(value) {
  if (value === '야근 적립') return '고객 추가 응대';
  if (value === '휴무출근 적립' || value === '휴무 출근 적립') return '휴무 고객응대';
  return value || '-';
}

function isFreepassDebitType(value) {
  return ['사용','사용처리','차감','월차전환','월차 전환'].includes(value);
}
function isFreepassActualUseType(value) {
  return ['사용','사용처리'].includes(value);
}
function freepassLedgerSignedHours(row) {
  const raw = Number(row?.hours || 0);
  const abs = Math.abs(raw);
  const type = row?.type || row?.request_type || '';
  if (isFreepassAccrualType(type)) return abs;
  if (isFreepassDebitType(type)) return -abs;
  return raw;
}
function freepassBalanceOf(rows, name) {
  return (rows || [])
    .filter(r => r.employee_name === name)
    .reduce((s,r)=>s+freepassLedgerSignedHours(r),0);
}
function freepassUsedInMonth(rows, name, ym = todayLocalISO().slice(0,7)) {
  return (rows || [])
    .filter(r => r.employee_name === name && String(r.effective_date || r.created_at || '').slice(0,7) === ym && isFreepassActualUseType(r.type))
    .reduce((s,r)=>s+Math.abs(Number(r.hours || 0)),0);
}

function formatTimeHHMM(date) {
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
}
function makeLocalDateTime(dateText, timeText = '00:00') {
  const safeDate = String(dateText || todayLocalISO()).slice(0, 10);
  const safeTime = normalizeWorkEndTime(timeText || '00:00');
  const [hh, mm] = safeTime.split(':').map(Number);
  const d = new Date(`${safeDate}T00:00:00`);
  d.setHours(hh || 0, mm || 0, 0, 0);
  return d;
}
function freepassUseTimeline({ requestDate, hours, employeeEndTime }) {
  const h = Number(hours || 0);
  const endTime = normalizeWorkEndTime(employeeEndTime || '20:00');
  const normalEndTime = makeLocalDateTime(requestDate, endTime);
  const actualLeaveTime = new Date(normalEndTime.getTime() - h * 60 * 60 * 1000);
  const deadline = new Date(actualLeaveTime.getTime() - 2 * 60 * 60 * 1000);
  return {
    employeeEndTime: endTime,
    normalEndTime,
    actualLeaveTime,
    deadline,
    normalEndLabel: formatTimeHHMM(normalEndTime),
    actualLeaveLabel: formatTimeHHMM(actualLeaveTime),
    deadlineLabel: formatTimeHHMM(deadline)
  };
}
function freepassUseAvailability({ userName = '', requestType, useType, requestDate, hours, employeeEndTime }) {
  if (requestType !== '사용' || !requestDate) return null;
  const h = Number(hours || 0);
  if (!h || h <= 0) return null;
  const now = new Date();

  if (useType === '오전 늦게 출근') {
    const deadline = makeLocalDateTime(requestDate, '01:00');
    const available = now <= deadline;
    return {
      available,
      title: available ? '신청 가능 시간' : '신청 불가 시간',
      message: available ? '사용일 오전 1시까지 신청 가능합니다.' : '사용일 오전 1시가 지나 신청할 수 없습니다.',
      detailLines: [`${userName || '본인'}님 기준`, '오전 늦게 출근은 사용일 오전 1시까지 신청 가능합니다.'],
      tone: available ? 'available' : 'unavailable'
    };
  }

  if (useType === '오후 일찍 퇴근') {
    const timeline = freepassUseTimeline({ requestDate, hours: h, employeeEndTime });
    const available = now <= timeline.deadline;
    return {
      available,
      title: available ? '신청 가능 시간' : '신청 불가 시간',
      message: available ? `${timeline.deadlineLabel}까지 신청 가능합니다.` : `${timeline.deadlineLabel}이 지나 신청할 수 없습니다.`,
      detailLines: [
        `${userName || '본인'}님 기준 퇴근 ${timeline.normalEndLabel}`,
        `${h}시간 사용 시 ${timeline.actualLeaveLabel} 퇴근`,
        `신청 가능 시간은 ${timeline.deadlineLabel}까지입니다.`
      ],
      tone: available ? 'available' : 'unavailable'
    };
  }

  return null;
}

function freepassPhotoTimeLabel(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

function validateFreepassRequest({ requestType, useType, requestDate, hours, useStartTime, currentUsed = 0, monthlyLimit = 10 }) {
  const h = Number(hours || 0);

  if (!requestType) return '신청 유형을 선택해주세요.';
  if (!requestDate) return requestType === '월차 전환' || requestType === '사용' ? '사용 요청 날짜를 선택해주세요.' : '적립 발생일을 선택해주세요.';
  if (!h || h <= 0) return '시간을 선택해주세요.';

  if (requestType === '사용' && h > 3) return '프리패스는 하루 최대 3시간까지만 사용할 수 있습니다.';

  if (requestType === '월차 전환') {
    if (h !== 10) return '월차 전환은 10시간만 가능합니다.';
    return '';
  }

  if (requestType === '사용' && currentUsed + h > Number(monthlyLimit || 10)) {
    return `프리패스는 월 최대 ${monthlyLimit}시간까지만 사용 가능합니다. 월차 전환은 제외됩니다.`;
  }

  const now = new Date();

  if (requestType === '사용' && useType === '오전 늦게 출근') {
    const deadline = makeLocalDateTime(requestDate, '01:00');
    if (now > deadline) return '오전 프리패스는 사용일 오전 1시까지 신청 가능합니다.';
  }

  if (requestType === '사용' && useType === '오후 일찍 퇴근') {
    const timeline = freepassUseTimeline({ requestDate, hours: h, employeeEndTime: useStartTime || '20:00' });

    if (now > timeline.deadline) {
      return `신청 가능 시간이 지났습니다.

기준 퇴근 ${timeline.normalEndLabel}
${h}시간 사용 시 ${timeline.actualLeaveLabel} 퇴근
신청 가능 시간은 ${timeline.deadlineLabel}까지입니다.`;
    }
  }

  return '';
}


function normalizeErrorText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}
function createErrorFingerprint({ currentTab, actionName, joinNo, error }) {
  return [
    normalizeErrorText(currentTab),
    normalizeErrorText(actionName),
    normalizeErrorText(joinNo),
    normalizeErrorText(error?.message || error || '')
  ].join('|').toLowerCase();
}
function getErrorThrottleKey(hash, userName) {
  return `error_report_throttle_${userName || 'unknown'}_${hash}`;
}
function wasErrorReportedWithinOneMinute(hash, userName) {
  try {
    const key = getErrorThrottleKey(hash, userName);
    const last = Number(localStorage.getItem(key) || 0);
    return last && (Date.now() - last < 60 * 1000);
  } catch { return false; }
}
function markErrorReportedNow(hash, userName) {
  try { localStorage.setItem(getErrorThrottleKey(hash, userName), String(Date.now())); } catch {}
}
function clearErrorReportedMark(hash, userName) {
  try { localStorage.removeItem(getErrorThrottleKey(hash, userName)); } catch {}
}
function askErrorReport({ user, currentTab = '', actionName = '', joinNo = '', error }) {
  const message = error?.message || String(error || '알 수 없는 오류');
  const errorHash = createErrorFingerprint({ currentTab, actionName, joinNo, error });

  if (wasErrorReportedWithinOneMinute(errorHash, user?.name)) {
    alert('이미 접수된 오류입니다.\n\n동일 오류는 1분 이내 다시 접수되지 않습니다.');
    return;
  }

  const ok = confirm(`오류가 발생했습니다.\n\n${message}\n\n이 오류를 관리자에게 보고할까요?`);
  if (ok) saveErrorReport({ user, currentTab, actionName, joinNo, error });
}

function parseVersionNumber(value) {
  const text = String(value || '').trim();
  const match = text.match(/v?\s*(\d+)\s*[\.-]\s*(\d+)/i);
  if (!match) return null;
  return Number(match[1]) * 1000 + Number(match[2]);
}

function isNewerVersion(latest, current) {
  const latestNum = parseVersionNumber(latest);
  const currentNum = parseVersionNumber(current);
  if (latestNum === null || currentNum === null) return latest && latest !== current;
  return latestNum > currentNum;
}

function UpdateNotice({ user, currentTab }) {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [nextVersion, setNextVersion] = useState('');
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let alive = true;
    let timer;

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

        const latestVersion = data?.version || '';
        if (isNewerVersion(latestVersion, APP_BUILD_VERSION)) {
          setNextVersion(latestVersion);
          setHasUpdate(true);
        } else {
          setNextVersion('');
          setHasUpdate(false);
        }
      } catch (e) {}
    }

    function handleVisible() {
      if (document.visibilityState === 'visible') checkVersion();
    }

    checkVersion();
    timer = setInterval(checkVersion, 2 * 60 * 1000);
    document.addEventListener('visibilitychange', handleVisible);
    window.addEventListener('focus', checkVersion);
    window.addEventListener('pageshow', checkVersion);
    window.addEventListener('online', checkVersion);
    window.addEventListener('popstate', checkVersion);
    window.addEventListener('hashchange', checkVersion);
    window.addEventListener('click', checkVersion, { passive: true });

    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisible);
      window.removeEventListener('focus', checkVersion);
      window.removeEventListener('pageshow', checkVersion);
      window.removeEventListener('online', checkVersion);
      window.removeEventListener('popstate', checkVersion);
      window.removeEventListener('hashchange', checkVersion);
      window.removeEventListener('click', checkVersion);
    };
  }, [user?.role, currentTab]);

  async function forceUpdateRefresh() {
    if (updating) return;
    setUpdating(true);
    try {
      try { localStorage.removeItem('sechan_dismissed_update_version'); } catch {}
      try { sessionStorage.clear(); } catch {}
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map(key => caches.delete(key)));
      }
    } catch (e) {}

    const base = `${window.location.origin}${window.location.pathname}`;
    window.location.replace(`${base}?app_refresh=${Date.now()}&target=${encodeURIComponent(nextVersion || 'latest')}`);
  }

  if (!hasUpdate) return null;

  return (
    <div className="updateNoticeBg mandatoryUpdateBg">
      <div className="updateNoticeBox mandatoryUpdateBox">
        <h2>새로운 버전이 있습니다</h2>
        <p>안정적인 사용을 위해 최신 버전으로 새로고침해야 합니다.</p>
        <p className="muted">현재 버전: {APP_BUILD_VERSION}<br />최신 버전: {nextVersion}</p>
        <div className="updateNoticeActions singleAction">
          <button className="primary" onClick={forceUpdateRefresh} disabled={updating}>{updating ? '새로고침 중...' : '최신 버전으로 새로고침'}</button>
        </div>
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



const FREEPASS_CONSENT_TEXT = `본 신청은 회사의 강제 지시, 명령 또는 사전 승인에 따른 연장근로·휴일근로 신청이 아닙니다.

본인은 개인의 고객관리, 판매활동, 사후응대 등 필요에 따라 자발적으로 고객 응대 또는 관련 업무를 수행하였으며, 이에 대한 프리패스 적립은 회사의 복지제도 운영에 따른 보상임을 확인합니다.

본 신청은 연장근로수당, 휴일근로수당 또는 임금 지급을 청구하기 위한 신청이 아니며, 회사가 업무시간 외 근무를 지시·요구·강제한 것으로 해석되지 않음을 확인하고 동의합니다.`;

function freepassConsentSnapshot(user, requestType, earnType) {
  return {
    agreed: true,
    agreed_at: new Date().toISOString(),
    agreed_by: user?.name || '',
    agreed_role: user?.role || '',
    agreed_store: user?.store_name || '',
    request_type: requestType || '',
    earn_type: earnType || '',
    consent_text: FREEPASS_CONSENT_TEXT,
    consent_version: 'freepass-welfare-v1'
  };
}

function FreepassModule({ user }) {
  const requestedFreepassTab = (() => {
    try { return localStorage.getItem('sechan_freepass_initial_tab') || ''; } catch { return ''; }
  })();
  const defaultTab = requestedFreepassTab || (isSuperAdmin(user) ? '점장 승인' : '내 프리패스');
  const [tab, setTab] = useState(defaultTab);

  useEffect(() => {
    if (requestedFreepassTab) {
      try { localStorage.removeItem('sechan_freepass_initial_tab'); } catch {}
    }
  }, []);

  const tabs = [];
  if (!isSuperAdmin(user)) tabs.push('내 프리패스', '사용 신청', '적립 요청');

  if (user.role === '점장' || isAdminLike(user)) tabs.push('점장 승인');
  if (isSuperAdmin(user)) tabs.push('최종 승인');

  if (user.role === '점장' || isAdminLike(user)) tabs.push('전체 현황');
  if (isAdminLike(user)) tabs.push('프리패스 로그');

  if (isSuperAdmin(user)) tabs.push('관리자 조정', '월 한도 설정', '반기 초기화');

  useEffect(() => {
    if (!tabs.includes(tab)) setTab(tabs[0] || '전체 현황');
  }, [user?.role]);

  return (
    <div className="freepassModule">
      <h2>프리패스</h2>
      <div className="filterBar moduleTabs">{tabs.map(t => <button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t}</button>)}</div>
      {tab==='내 프리패스' && !isSuperAdmin(user) && <FreepassMyPage user={user} />}
      {tab==='사용 신청' && !isSuperAdmin(user) && <FreepassRequestForm user={user} />}
      {tab==='적립 요청' && !isSuperAdmin(user) && <AccrualRequestTab user={user} />}
      {tab==='점장 승인' && <FreepassApprovalQueue user={user} mode="manager" />}
      {tab==='최종 승인' && <FreepassApprovalQueue user={user} mode="final" />}
      {tab==='전체 현황' && <FreepassStoreOverview user={user} />}
      {tab==='프리패스 로그' && <FreepassLogTab user={user} />}
      {tab==='관리자 조정' && <FreepassAdminAdjust user={user} />}
      {tab==='월 한도 설정' && <FreepassLimitSettings user={user} />}
      {tab==='반기 초기화' && <FreepassSemiannualReset user={user} />}
    </div>
  );
}

function FreepassMyPage({ user }) {
  const [ledger,setLedger]=useState([]);
  const [requests,setRequests]=useState([]);
  const [selected,setSelected]=useState(null);
  const [editMode,setEditMode]=useState(false);
  const [editDraft,setEditDraft]=useState({});
  const [monthlyLimit,setMonthlyLimit]=useState(10);

  useEffect(()=>{ load(); },[]);

  async function load(){
    const {data:l}=await supabase.from('freepass_ledger').select('*').order('created_at',{ascending:false});
    const {data:r}=await supabase.from('freepass_requests').select('*').eq('employee_name',user.name).order('requested_at',{ascending:false});
    setLedger(l||[]);
    setRequests(r||[]);
    setMonthlyLimit(await getFreepassMonthlyLimit());
  }

  const myRows=ledger.filter(r=>r.employee_name===user.name);
  const requestMap = useMemo(()=>Object.fromEntries((requests||[]).map(r=>[r.id,r])), [requests]);
  const balance=freepassBalanceOf(ledger,user.name);
  const pending = pendingDebitHours(requests, user.name);
  const available = balance - pending;
  const tone = getBalanceTone(balance);

  function openDetail(row){
    setSelected(row);
    setEditMode(false);
    setEditDraft({
      request_date: row.request_date || todayLocalISO(),
      use_type: row.use_type || '오전 늦게 출근',
      hours: Number(row.hours || 1),
      reason: row.reason || ''
    });
  }

  async function cancelRequest(row){
    if(!isCancelableFreepassRequest(row)) return alert('승인 완료/반려/취소된 건은 취소할 수 없습니다.');
    if(!confirm('이 신청을 취소할까요?')) return;
    try{
      const {error}=await supabase.from('freepass_requests').update({
        status:'신청취소',
        final_status:'취소',
        reject_reason:'본인 취소'
      }).eq('id', row.id).eq('employee_name', user.name);
      if(error) throw error;
      await writeAuditLog('프리패스본인취소','freepass_requests',row.id,user,`${row.request_type} / ${row.hours}시간`);
      alert('신청이 취소되었습니다.');
      setSelected(null);
      load();
    }catch(e){
      askErrorReport({user,currentTab:'프리패스',actionName:'본인 신청 취소',error:e});
    }
  }

  async function saveEdit(row){
    if(!isEditableFreepassRequest(row)) return alert('이 신청은 수정할 수 없습니다.');
    const need = Number(editDraft.hours || 0);
    if(need <= 0) return alert('시간을 입력해주세요.');
    const pendingExceptMe = pendingDebitHours(requests, user.name, row.id);
    const availableExceptMe = balance - pendingExceptMe;
    if(need > availableExceptMe){
      return alert(`수정 가능 시간이 부족합니다.\n\n잔여 프리패스: ${balance}시간\n다른 승인대기 사용/전환: ${pendingExceptMe}시간\n수정 가능: ${availableExceptMe}시간\n수정 요청: ${need}시간`);
    }
    try{
      const patch = {
        request_date: editDraft.request_date,
        hours: need,
        reason: editDraft.reason,
        updated_at: new Date().toISOString()
      };
      if(row.request_type === '사용') patch.use_type = editDraft.use_type;
      const {error}=await supabase.from('freepass_requests').update(patch).eq('id', row.id).eq('employee_name', user.name);
      if(error) throw error;
      await writeAuditLog('프리패스본인수정','freepass_requests',row.id,user,`${row.request_type} / ${need}시간`);
      alert('신청이 수정되었습니다.');
      setEditMode(false);
      setSelected(null);
      load();
    }catch(e){
      askErrorReport({user,currentTab:'프리패스',actionName:'본인 신청 수정',error:e});
    }
  }

  return <div>
    <div className="summaryGrid">
      <Card title="잔여 프리패스" value={`${balance}시간`} valueClass={`timeValue ${tone}`} />
      <Card title="신청 가능" value={`${available}시간`} />
      <Card title="승인대기 사용" value={`${pending}시간`} />
      <Card title="월 사용 한도" value={`${monthlyLimit}시간`} />
    </div>

    <div className="sectionCard">
      <h3>내 신청 현황</h3>
      <p className="muted">승인대기 중인 사용/월차전환 시간은 신청 가능 시간에서 먼저 차감됩니다.</p>
      <table>
        <thead><tr><th>요청일시</th><th>유형</th><th>실제 사용/발생일</th><th>시간</th><th>사유</th><th>상태</th></tr></thead>
        <tbody>
          {requests.map(r=><tr key={r.id} className="clickableRow" onClick={()=>openDetail(r)}>
            <td>{formatKST(r.requested_at||r.created_at)}</td>
            <td>{freepassTypeLabel(r.request_type)} {r.use_type||''}</td>
            <td>{r.request_date}</td>
            <td>{r.hours}시간</td>
            <td>{r.reason||'-'}</td>
            <td><span className={`requestStatusBadge ${pushStatusClass(r.status)}`}>{pushStatusLabel(r.status)}</span></td>
          </tr>)}
          {!requests.length&&<tr><td colSpan="6" className="muted">신청 내역이 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>

    <div className="sectionCard">
      <h3>내 프리패스 이력</h3>
      <table className="freepassLedgerTable readableFreepassTable"><thead><tr><th>구분</th><th>시간</th><th>요청일시</th><th>실제일</th><th>사유</th><th>처리자</th></tr></thead>
      <tbody>
        {myRows.map(r=><tr key={r.id}><td>{freepassTypeLabel(r.type)}</td><td>{freepassLedgerSignedHours(r)>0?`+${freepassLedgerSignedHours(r)}`:freepassLedgerSignedHours(r)}시간</td><td>{freepassRequestedDateTimeLabel(r, requestMap)}</td><td>{freepassActualDateLabel(r)}</td><td className="freepassReasonCell">{r.reason||'-'}</td><td>{r.created_by||'-'}</td></tr>)}
        {!myRows.length&&<tr><td colSpan="6" className="muted">프리패스 이력이 없습니다.</td></tr>}
      </tbody></table>
    </div>

    {selected&&<div className="modalBg"><div className="modal">
      <div className="modalHead"><h2>프리패스 신청 상세</h2><button onClick={()=>setSelected(null)}>닫기</button></div>
      {!editMode && <section className="infoGrid">
        <p><b>접수 날짜·시각</b><br />{formatKST(selected.requested_at||selected.created_at)}</p>
        <p><b>신청 유형</b><br />{freepassTypeLabel(selected.request_type)} {selected.use_type||''}</p>
        <p><b>상태</b><br /><span className={`requestStatusBadge ${pushStatusClass(selected.status)}`}>{pushStatusLabel(selected.status)}</span></p>
        <p><b>실제 사용/발생일</b><br />{selected.request_date}</p>
        <p><b>시간</b><br />{selected.hours}시간</p>
        <p><b>점장 승인</b><br />{selected.manager_status||'대기'} {selected.manager_approved_by?`· ${selected.manager_approved_by}`:''}</p>
        <p><b>최종 승인</b><br />{selected.final_status||'대기'} {selected.final_approved_by?`· ${selected.final_approved_by}`:''}</p>
        <p><b>반려/취소 사유</b><br />{selected.reject_reason||'-'}</p>
        <p><b>신청 사유</b><br />{selected.reason||'-'}</p>
      </section>}

      {editMode && <section className="sectionCard innerEditBox">
        <h3>신청 수정</h3>
        <div className="formGrid">
          <label>적립 발생일<input type="date" value={editDraft.request_date} onChange={e=>setEditDraft(p=>({...p,request_date:e.target.value}))} /></label>
          {selected.request_type === '사용' && <label>사용 구분<select value={editDraft.use_type} onChange={e=>setEditDraft(p=>({...p,use_type:e.target.value}))}><option>오전 늦게 출근</option><option>오후 일찍 퇴근</option></select></label>}
          <label>시간<select value={editDraft.hours} onChange={e=>setEditDraft(p=>({...p,hours:Number(e.target.value)}))}>{selected.request_type==='월차 전환'?<option value={10}>10시간</option>:<><option value={1}>1시간</option><option value={2}>2시간</option><option value={3}>3시간</option></>}</select></label>
        </div>
        <textarea value={editDraft.reason} onChange={e=>setEditDraft(p=>({...p,reason:e.target.value}))} placeholder="사유 입력" />
        <div className="reviewActions"><button className="primary" onClick={()=>saveEdit(selected)}>수정 저장</button><button onClick={()=>setEditMode(false)}>수정 취소</button></div>
      </section>}

      <div className="reviewActions">
        {isEditableFreepassRequest(selected) && !editMode && <button className="primary" onClick={()=>setEditMode(true)}>수정</button>}
        {isCancelableFreepassRequest(selected) && <button className="dangerBtn" onClick={()=>cancelRequest(selected)}>신청 취소</button>}
      </div>
    </div></div>}
  </div>;
}


function FreepassRequestForm({ user }) {
  const [requestType,setRequestType]=useState('사용');
  const [useType,setUseType]=useState('오전 늦게 출근');
  const [requestDate,setRequestDate]=useState(todayLocalISO());
  const [hours,setHours]=useState(1);
  const [useStartTime,setUseStartTime]=useState('');
  const [reason,setReason]=useState('');
  const [photoItems,setPhotoItems]=useState([]);
  const [ledger,setLedger]=useState([]);
  const [requests,setRequests]=useState([]);
  const [busy,setBusy]=useState(false);
  const [monthlyLimit,setMonthlyLimit]=useState(10);
  const [employeeProfile,setEmployeeProfile]=useState(user);
  const employeeEndTime = employeeWorkEndTime(employeeProfile || user);
  const availability = freepassUseAvailability({ userName:user.name, requestType, useType, requestDate, hours: requestType === '월차 전환' ? 10 : hours, employeeEndTime });
  useEffect(()=>{
    supabase.from('freepass_ledger').select('*').then(({data})=>setLedger(data||[]));
    supabase.from('freepass_requests').select('*').eq('employee_name', user.name).then(({data})=>setRequests(data||[]));
    getFreepassMonthlyLimit().then(setMonthlyLimit);
    loadEmployeeProfile();
  },[user?.id,user?.name]);

  async function loadEmployeeProfile(){
    try{
      let query = supabase.from('employees').select('*');
      if(user?.id) query = query.eq('id', user.id);
      else query = query.eq('name', user.name);
      const {data,error}=await query.maybeSingle();
      if(error) throw error;
      if(data) setEmployeeProfile(data);
    }catch(e){
      console.warn('employee profile refresh skipped', e?.message || e);
    }
  }
  async function onPhoto(file){
    if(!file) return;
    if(photoItems.length >= 2) return alert('사진은 최대 2장까지 첨부 가능합니다.');
    const capturedAt = new Date().toISOString();
    const reader=new FileReader();
    reader.onload=()=>setPhotoItems(prev=>[...prev,{ data:String(reader.result||''), captured_at:capturedAt }].slice(0,2));
    reader.readAsDataURL(file);
  }
  function removePhoto(idx){
    setPhotoItems(prev=>prev.filter((_,i)=>i!==idx));
  }
  async function submit(){
    if(!reason.trim()) return alert('사유를 입력해주세요.');
    const requestYm = String(requestDate).slice(0,7);
    const currentUsed=freepassUsedInMonth(ledger,user.name,requestYm) + pendingActualUseHoursInMonth(requests,user.name,requestYm);
    const effectiveHours = requestType === '월차 전환' ? 10 : Number(hours);
    const validation=validateFreepassRequest({requestType,useType,requestDate,hours:effectiveHours,useStartTime:employeeEndTime,currentUsed,monthlyLimit});
    if(validation) return alert(validation);
    if(requestType==='사용' || requestType==='월차 전환'){
      const balance = freepassBalanceOf(ledger, user.name);
      const pending = pendingDebitHours(requests, user.name);
      const available = balance - pending;
      const need = Math.abs(Number(effectiveHours || 0));
      if(need > available){
        return alert(`신청 가능 시간이 부족합니다.\n\n잔여 프리패스: ${balance}시간\n승인대기 사용/전환: ${pending}시간\n신청 가능: ${available}시간\n신청 요청: ${need}시간`);
      }
    }
    if((requestType==='야근 적립'||requestType==='휴무출근 적립') && !photoItems.length) return alert('적립 신청은 타임스탬프 사진 직접 촬영이 필요합니다.');
    setBusy(true);
    try{
      let employeeQuery = supabase.from('employees').select('*');
      if(user?.id) employeeQuery = employeeQuery.eq('id', user.id);
      else employeeQuery = employeeQuery.eq('name', user.name);
      const {data:latestEmployee,error:employeeError}=await employeeQuery.maybeSingle();
      if(employeeError) throw employeeError;
      if(!latestEmployee) throw new Error('직원관리의 최신 직원 정보를 찾을 수 없습니다. 관리자에게 확인해주세요.');

      const latestStore = normalizeOfficeStoreName(latestEmployee.store_name);
      const skipManagerApproval = latestEmployee.role === '점장' || latestStore === '사무실';
      const nextStatus = skipManagerApproval ? '최종승인대기' : '점장승인대기';
      const nowIso = new Date().toISOString();

      const {error}=await supabase.from('freepass_requests').insert({
        employee_id:latestEmployee.id, employee_name:latestEmployee.name, employee_store:latestEmployee.store_name,
        request_type:requestType, use_type:requestType==='사용'?useType:null,
        request_date:requestDate, use_start_time:requestType==='사용' && useType==='오후 일찍 퇴근' ? employeeWorkEndTime(latestEmployee) : (useStartTime||null), hours:Number(effectiveHours ?? hours),
        reason, evidence_photo_data:(requestType==='야근 적립'||requestType==='휴무출근 적립')?JSON.stringify(photoItems):null,
        status:nextStatus,
        manager_status:skipManagerApproval?'점장승인생략':'대기',
        final_status:'대기',
        requested_at:nowIso,
        manager_approved_by:skipManagerApproval?latestEmployee.name:null,
        manager_approved_at:skipManagerApproval?nowIso:null
      });
      if(error) throw error;
      await writeAuditLog('프리패스신청','freepass_requests',user.name,user,`${requestType} ${hours}시간 / ${reason}`);
      alert('프리패스 신청이 등록되었습니다.');
      setReason(''); setPhotoItems([]);
    }catch(e){ askErrorReport({user,currentTab:'프리패스',actionName:'프리패스 신청',error:e}); }
    finally{ setBusy(false); }
  }
  return <div className="sectionCard">
    <h3>프리패스 신청</h3>
    <div className="formGrid">
      <label>신청 유형<select value={requestType} onChange={e=>{ const v=e.target.value; setRequestType(v); if(v==='월차 전환') setHours(10); }}><option>사용</option><option>월차 전환</option></select></label>
      {requestType==='사용' && <label>사용 구분<select value={useType} onChange={e=>setUseType(e.target.value)}><option>오전 늦게 출근</option><option>오후 일찍 퇴근</option></select></label>}
      <label>사용/적립일<input type="date" value={requestDate} onChange={e=>setRequestDate(e.target.value)} /></label>
      <label>시간<select value={hours} onChange={e=>setHours(Number(e.target.value))}>{requestType==='월차 전환'?<option value={10}>10시간</option>:<><option value={1}>1시간</option><option value={2}>2시간</option><option value={3}>3시간</option></>}</select></label>
    </div>
    {availability && <div className={`freepassAvailabilityBox ${availability.tone}`}>
      <span className="freepassAvailabilityTitle">{availability.title}</span>
      <strong>{availability.message}</strong>
      <div className="freepassAvailabilityDetail">
        {availability.detailLines?.map((line, idx)=><p key={idx}>{line}</p>)}
      </div>
    </div>}
    {(requestType==='야근 적립'||requestType==='휴무출근 적립') && <div className="photoCaptureBox"><p className="muted">현장에서 직접 촬영한 타임스탬프 사진만 첨부해주세요. 최대 2장까지 가능하며, 최종 승인 시 사진 데이터는 즉시 삭제됩니다.</p><input type="file" accept="image/*" capture="environment" onChange={e=>onPhoto(e.target.files?.[0])}/>
      <div className="evidenceGrid">
        {photoItems.map((p,idx)=><div className="evidenceItem" key={idx}><img className="evidencePreview" src={p.data} alt={`증빙 ${idx+1}`} /><p>촬영일시: {freepassPhotoTimeLabel(p.captured_at)}</p><button type="button" onClick={()=>removePhoto(idx)}>삭제/재촬영</button></div>)}
      </div>
    </div>}
    <textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="사유 입력" />
    <button className="primary" onClick={submit} disabled={busy}>신청 등록</button>
  </div>;
}


function AccrualRequestTab({ user }) {
  const [mode,setMode]=useState('고객 추가 응대');
  const [rows,setRows]=useState([]);
  const [nightDate,setNightDate]=useState(todayLocalISO());
  const [nightHours,setNightHours]=useState(1);
  const [reason,setReason]=useState('');
  const [photoItems,setPhotoItems]=useState([]);
  const [startPhoto,setStartPhoto]=useState(null);
  const [endPhoto,setEndPhoto]=useState(null);
  const [endHours,setEndHours]=useState(1);
  const [selected,setSelected]=useState(null);
  const [busy,setBusy]=useState(false);

  useEffect(()=>{ load(); },[]);

  function normalizeAccrualType(v){
    if (v === '야근 적립') return '고객 추가 응대';
    if (v === '휴무출근 적립' || v === '휴무 출근 적립') return '휴무 고객응대';
    return v || '';
  }

  async function load(){
    const {data}=await supabase
      .from('freepass_requests')
      .select('*')
      .eq('employee_name', user.name)
      .in('request_type', ['고객 추가 응대','휴무 고객응대','야근 적립','휴무출근 적립'])
      .order('requested_at', { ascending:false });
    setRows(data||[]);
  }

  function confirmConsent(requestType){
    const ok = confirm(`${FREEPASS_CONSENT_TEXT}

위 내용을 확인하고 동의해야 프리패스 적립 요청이 접수됩니다.`);
    if(!ok) return null;
    return freepassConsentSnapshot(user, '적립 요청', requestType);
  }

  async function capturePhoto(file, setter, label){
    if(!file) return;
    const capturedAt = new Date().toISOString();
    const reader = new FileReader();
    reader.onload = () => setter({ type: label, data: String(reader.result||''), captured_at: capturedAt });
    reader.readAsDataURL(file);
  }

  async function addNightPhoto(file){
    if(!file) return;
    const capturedAt = new Date().toISOString();
    const reader = new FileReader();
    reader.onload = () => {
      const item = { type:'고객 추가 응대', data:String(reader.result||''), captured_at:capturedAt };
      setPhotoItems([item]);
      setNightDate(dateFromCapturedAt(item));
    };
    reader.readAsDataURL(file);
  }

  async function submitNight(){
    if(!photoItems.length) return alert('사진 촬영 후 적립 요청이 가능합니다.');
    if(!reason.trim()) return alert('고객 응대 내용을 입력해주세요.');
    const consent = confirmConsent('고객 추가 응대');
    if(!consent) return;
    setBusy(true);
    try{
      const requestDate = dateFromCapturedAt(photoItems[0], nightDate);
      const {error}=await supabase.from('freepass_requests').insert({
        employee_id:user.id, employee_name:user.name, employee_store:user.store_name,
        request_type:'고객 추가 응대', use_type:null, request_date:requestDate, hours:Number(nightHours), reason,
        evidence_photo_data:JSON.stringify(photoItems),
        consent_agreed:true,
        consent_agreed_at:consent.agreed_at,
        consent_text:consent.consent_text,
        consent_snapshot:consent,
        status:'최종승인대기', manager_status:'점장승인생략', final_status:'대기',
        requested_at:new Date().toISOString(), manager_approved_by:user.name, manager_approved_at:new Date().toISOString()
      });
      if(error) throw error;
      await writeAuditLog('고객추가응대적립신청','freepass_requests',user.name,user,`${requestDate} / ${nightHours}시간 / ${reason} / 동의완료`);
      alert('프리패스 적립 요청이 접수되었습니다.');
      setReason(''); setPhotoItems([]); setNightHours(1); setNightDate(todayLocalISO()); load();
    }catch(e){ askErrorReport({user,currentTab:'프리패스 적립 요청',actionName:'고객 추가 응대 신청',error:e}); }
    finally{ setBusy(false); }
  }

  async function saveStartDraft(){
    if(!startPhoto) return alert('응대 시작 사진을 촬영해주세요.');
    if(!reason.trim()) return alert('고객 응대 내용을 입력해주세요.');
    const requestDate = dateFromCapturedAt(startPhoto);
    setBusy(true);
    try{
      const {error}=await supabase.from('freepass_requests').insert({
        employee_id:user.id, employee_name:user.name, employee_store:user.store_name,
        request_type:'휴무 고객응대', use_type:null, request_date:requestDate, hours:0, reason,
        evidence_photo_data:buildEvidencePhotos({startPhoto}),
        status:'임시저장', manager_status:'점장승인생략', final_status:'대기',
        requested_at:new Date().toISOString(), manager_approved_by:user.name, manager_approved_at:new Date().toISOString()
      });
      if(error) throw error;
      await writeAuditLog('휴무고객응대시작사진임시저장','freepass_requests',user.name,user,`${requestDate} / ${reason}`);
      alert('응대 시작 사진이 임시저장되었습니다. 종료 시 신청현황에서 해당 건을 눌러 종료 사진과 적립 시간을 입력해주세요.');
      setStartPhoto(null); setReason(''); load();
    }catch(e){ askErrorReport({user,currentTab:'프리패스 적립 요청',actionName:'휴무 고객응대 시작 사진 임시저장',error:e}); }
    finally{ setBusy(false); }
  }

  async function submitHolidayFinal(row){
    if(!endPhoto) return alert('응대 종료 사진을 촬영해주세요.');
    if(!endHours || Number(endHours) <= 0) return alert('적립 시간을 선택해주세요.');
    const consent = confirmConsent('휴무 고객응대');
    if(!consent) return;
    const requestDate = dateFromCapturedAt(endPhoto, row.request_date);
    setBusy(true);
    try{
      const existing = parseEvidencePhotos(row.evidence_photo_data);
      const photos = [...existing.filter(p => p.type !== '응대 종료' && p.type !== '퇴근'), endPhoto];
      const {error}=await supabase.from('freepass_requests').update({
        evidence_photo_data:JSON.stringify(photos),
        status:'최종승인대기',
        final_status:'대기',
        request_date:requestDate,
        hours:Number(endHours),
        consent_agreed:true,
        consent_agreed_at:consent.agreed_at,
        consent_text:consent.consent_text,
        consent_snapshot:consent
      }).eq('id', row.id);
      if(error) throw error;
      await writeAuditLog('휴무고객응대최종신청','freepass_requests',row.id,user,`${requestDate} / ${endHours}시간 / 동의완료`);
      alert('휴무 고객응대 적립 요청이 접수되었습니다.');
      setEndPhoto(null); setEndHours(1); setSelected(null); load();
    }catch(e){ askErrorReport({user,currentTab:'프리패스 적립 요청',actionName:'휴무 고객응대 최종 저장',error:e}); }
    finally{ setBusy(false); }
  }

  return (
    <div>
      <div className="sectionCard accrualCard">
        <h3>프리패스 적립 요청</h3>
        <div className="freepassConsentNotice">
          <b>안내</b>
          <p>업무시간 외 고객응대 및 업무수행은 원칙적으로 금지됩니다. 프리패스 적립은 회사의 연장근로 지시 또는 휴일근로 지시에 따른 수당 신청이 아닌 복지제도 신청입니다.</p>
        </div>
        <div className="filterBar moduleTabs">
          <button className={mode==='고객 추가 응대'?'active':''} onClick={()=>setMode('고객 추가 응대')}>고객 추가 응대</button>
          <button className={mode==='휴무 고객응대'?'active':''} onClick={()=>setMode('휴무 고객응대')}>휴무 고객응대</button>
        </div>

        {mode==='고객 추가 응대' && <>
          <div className="formGrid compactFormGrid">
            <label>응대 발생일<input type="date" value={nightDate} onChange={e=>setNightDate(e.target.value)} /></label>
            <label>복지 적립 시간<select value={nightHours} onChange={e=>setNightHours(Number(e.target.value))}><option value={1}>1시간</option><option value={2}>2시간</option><option value={3}>3시간</option></select></label>
          </div>
          <textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="고객 응대 내용을 작성해주세요. 예) 퇴근 후 기존 고객 기기변경 상담, 인터넷 개통 고객 추가 응대" />
          <div className="photoCaptureBox">
            <label className="cameraButton">사진 촬영<input type="file" accept="image/*" capture="environment" onChange={e=>addNightPhoto(e.target.files?.[0])} /></label>
            <div className="evidenceGrid">
              {photoItems.map((p,idx)=><div className="evidenceItem" key={idx}><img className="evidencePreview" src={p.data} alt="고객 추가 응대 증빙" /><p>촬영일시: {freepassPhotoTimeLabel(p.captured_at)}</p><button type="button" onClick={()=>setPhotoItems([])}>삭제/재촬영</button></div>)}
            </div>
            <button className="primary" disabled={busy || !photoItems.length} onClick={submitNight}>{photoItems.length ? '동의 후 적립 요청' : '사진 촬영 후 활성화'}</button>
          </div>
        </>}

        {mode==='휴무 고객응대' && <>
          <textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="휴무 중 고객 응대 내용을 작성해주세요. 예) 휴무일 기존 고객 상담, 가족결합 안내, 긴급 개통 지원" />
          <div className="photoCaptureBox">
            <p className="muted">1단계 응대 시작 사진 임시저장 → 2단계 응대 종료 사진 등록 시 적립 시간 선택 → 동의 후 최종 승인 요청 순서로 진행됩니다.</p>
            <div className="buttonRow">
              <label className="cameraButton">응대 시작 사진 촬영<input type="file" accept="image/*" capture="environment" onChange={e=>capturePhoto(e.target.files?.[0], setStartPhoto, '응대 시작')} /></label>
              <button className="primary" disabled={busy || !startPhoto} onClick={saveStartDraft}>{startPhoto ? '1차 임시저장' : '촬영 후 임시저장 가능'}</button>
            </div>
            {startPhoto && <div className="evidenceItem"><img className="evidencePreview" src={startPhoto.data} alt="응대 시작 사진" /><p>촬영일시: {freepassPhotoTimeLabel(startPhoto.captured_at)}</p><button type="button" onClick={()=>setStartPhoto(null)}>삭제/재촬영</button></div>}
          </div>
        </>}
      </div>

      <div className="sectionCard">
        <h3>적립 요청 신청현황</h3>
        <p className="muted">휴무 고객응대 임시저장 건은 해당 행을 눌러 응대 종료 사진과 적립 시간을 추가하면 최종 신청됩니다.</p>
        <table>
          <thead><tr><th>접수 날짜·시각</th><th>유형</th><th>응대 발생일</th><th>시간</th><th>내용</th><th>동의</th><th>상태</th></tr></thead>
          <tbody>
            {rows.map(r=><tr key={r.id} className="clickableRow" onClick={()=>setSelected(r)}>
              <td>{formatKST(r.requested_at || r.created_at)}</td>
              <td>{normalizeAccrualType(r.request_type)}</td>
              <td>{r.request_date || '-'}</td>
              <td>{Number(r.hours||0) ? `${r.hours}시간` : '-'}</td>
              <td>{r.reason || '-'}</td>
              <td>{r.consent_agreed ? '동의완료' : '-'}</td>
              <td><span className={`requestStatusBadge ${pushStatusClass(r.status)}`}>{pushStatusLabel(r.status)}</span></td>
            </tr>)}
            {!rows.length && <tr><td colSpan="7" className="muted">적립 요청 내역이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>

      {selected && <div className="modalBg"><div className="modal accrualDetailModal">
        <div className="modalHead"><h2>적립 요청 상세</h2><button onClick={()=>{setSelected(null);setEndPhoto(null);setEndHours(1);}}>닫기</button></div>
        <section className="infoGrid">
          <p><b>접수 날짜·시각</b><br />{formatKST(selected.requested_at || selected.created_at)}</p>
          <p><b>유형</b><br />{normalizeAccrualType(selected.request_type)}</p>
          <p><b>응대 발생일</b><br />{selected.request_date || '-'}</p>
          <p><b>적립 시간</b><br />{Number(selected.hours||0) ? `${selected.hours}시간` : '-'}</p>
          <p><b>상태</b><br /><span className={`requestStatusBadge ${pushStatusClass(selected.status)}`}>{pushStatusLabel(selected.status)}</span></p>
          <p><b>고객 응대 내용</b><br />{selected.reason || '-'}</p>
          <p><b>동의 여부</b><br />{selected.consent_agreed ? `동의완료 (${formatKST(selected.consent_agreed_at)})` : '-'}</p>
        </section>
        {selected.consent_text && <div className="freepassConsentRecord"><b>동의 문구 기록</b><p>{selected.consent_text}</p></div>}
        <div className="evidenceGrid">
          {parseEvidencePhotos(selected.evidence_photo_data).map((p,idx)=><div className="evidenceItem" key={idx}><b>{p.type || `사진 ${idx+1}`}</b><img className="evidencePreview" src={p.data || p} alt={p.type || `증빙 ${idx+1}`} />{p.captured_at && <p>촬영일시: {freepassPhotoTimeLabel(p.captured_at)}</p>}</div>)}
        </div>
        {normalizeAccrualType(selected.request_type)==='휴무 고객응대' && selected.status === '임시저장' && <div className="photoCaptureBox">
          <div className="formGrid compactFormGrid">
            <label>적립 시간<select value={endHours} onChange={e=>setEndHours(Number(e.target.value))}><option value={1}>1시간</option><option value={2}>2시간</option><option value={3}>3시간</option></select></label>
          </div>
          <div className="buttonRow">
            <label className="cameraButton">응대 종료 사진 촬영<input type="file" accept="image/*" capture="environment" onChange={e=>capturePhoto(e.target.files?.[0], setEndPhoto, '응대 종료')} /></label>
            <button className="primary" disabled={busy || !endPhoto} onClick={()=>submitHolidayFinal(selected)}>{endPhoto ? '동의 후 최종 요청' : '응대 종료 사진 촬영 후 활성화'}</button>
          </div>
          {endPhoto && <div className="evidenceItem"><img className="evidencePreview" src={endPhoto.data} alt="응대 종료 사진" /><p>촬영일시: {freepassPhotoTimeLabel(endPhoto.captured_at)}</p><button type="button" onClick={()=>setEndPhoto(null)}>삭제/재촬영</button></div>}
        </div>}
      </div></div>}
    </div>
  );
}
function FreepassApprovalQueue({ user, mode }) {
  const [rows,setRows]=useState([]);
  const [selected,setSelected]=useState(null);
  const [loading,setLoading]=useState(true);
  const [processingId,setProcessingId]=useState(null);
  const [selectedLog, setSelectedLog] = useState(null);

  useEffect(()=>{load();},[mode]);

  function isAccrualRequest(row){
    return ['고객 추가 응대','휴무 고객응대','야근 적립','휴무출근 적립','휴무 출근 적립'].includes(row.request_type);
  }

  function displayRequestType(row){
    if(row.request_type === '야근 적립') return '고객 추가 응대';
    if(row.request_type === '휴무출근 적립' || row.request_type === '휴무 출근 적립') return '휴무 고객응대';
    return row.request_type || '-';
  }

  async function load(){
    setLoading(true);
    try{
      const targetStatus = mode === 'manager' ? '점장승인대기' : '최종승인대기';
      let query = supabase
        .from('freepass_requests')
        .select('*')
        .eq('status', targetStatus)
        .order('requested_at',{ascending:false});
      if(mode==='manager' && user.role==='점장') query = query.eq('employee_store', user.store_name);
      const {data,error}=await query;
      if(error) throw error;
      setRows(data||[]);
    }catch(e){
      askErrorReport({user,currentTab:'프리패스 승인',actionName:'승인 목록 조회',error:e});
    }finally{
      setLoading(false);
    }
  }

  async function approve(row){
    if(processingId) return;
    setProcessingId(row.id);
    try{
      if(mode==='manager'){
        const {data:current,error:readError}=await supabase.from('freepass_requests').select('*').eq('id',row.id).maybeSingle();
        if(readError) throw readError;
        if(!current || current.status !== '점장승인대기'){
          alert('이미 처리된 신청입니다. 목록을 새로고침합니다.');
          setSelected(null);
          await load();
          return;
        }
        const {error}=await supabase.from('freepass_requests').update({
          status:'최종승인대기',
          manager_status:'승인',
          manager_approved_by:user.name,
          manager_approved_at:new Date().toISOString()
        }).eq('id',row.id).eq('status','점장승인대기');
        if(error) throw error;
        await writeAuditLog('프리패스점장승인','freepass_requests',row.id,user,`${row.employee_name} ${row.hours}시간`);
      } else {
        if(!isSuperAdmin(user)) return alert('최종 승인은 최고관리자만 가능합니다.');

        const {data:current,error:readError}=await supabase.from('freepass_requests').select('*').eq('id',row.id).maybeSingle();
        if(readError) throw readError;
        if(!current || current.status !== '최종승인대기'){
          alert('이미 처리된 신청입니다. 목록을 새로고침합니다.');
          setSelected(null);
          await load();
          return;
        }
        const {data:existingLedger,error:ledgerFindError}=await supabase
          .from('freepass_ledger')
          .select('id')
          .eq('source_request_id',row.id)
          .limit(1);
        if(ledgerFindError) throw ledgerFindError;
        if(existingLedger && existingLedger.length){
          alert('이미 프리패스 이력이 생성된 신청입니다. 중복 처리를 차단하고 목록을 새로고침합니다.');
          setSelected(null);
          await load();
          return;
        }

        const accrual = isAccrualRequest(current);
        const type = accrual ? '적립' : (current.request_type==='월차 전환' ? '월차전환' : '사용');
        const hoursValue = accrual ? Math.abs(Number(current.hours || 0)) : -Math.abs(Number(current.hours || 0));

        const {error:reqError}=await supabase.from('freepass_requests').update({
          status:'최종승인완료',
          final_status:'승인',
          final_approved_by:user.name,
          final_approved_at:new Date().toISOString(),
          evidence_photo_data:null,
          evidence_deleted_at:new Date().toISOString()
        }).eq('id',row.id).eq('status','최종승인대기');
        if(reqError) throw reqError;

        const {data:ledgerAgain,error:ledgerAgainError}=await supabase
          .from('freepass_ledger')
          .select('id')
          .eq('source_request_id',row.id)
          .limit(1);
        if(ledgerAgainError) throw ledgerAgainError;
        if(!ledgerAgain || !ledgerAgain.length){
          const {error:ledgerError}=await supabase.from('freepass_ledger').insert({
            employee_id:current.employee_id,
            employee_name:current.employee_name,
            employee_store:current.employee_store,
            type,
            hours:hoursValue,
            reason:current.reason,
            source_request_id:current.id,
            effective_date:current.request_date,
            created_by:user.name
          });
          if(ledgerError) throw ledgerError;
        }

        await writeAuditLog('프리패스최종승인','freepass_requests',row.id,user,`${current.employee_name} ${type} ${Math.abs(Number(current.hours||0))}시간 / ledger ${hoursValue}`);
      }
      alert('승인 처리되었습니다.');
      setRows(prev=>prev.filter(item=>item.id!==row.id));
      setSelected(null);
      await load();
    }catch(e){
      askErrorReport({user,currentTab:'프리패스 승인',actionName:'승인',error:e});
    }finally{
      setProcessingId(null);
    }
  }

  async function reject(row){
    const memo=prompt('반려 사유를 입력해주세요.');
    if(!memo) return;
    try{
      const patch=mode==='manager'
        ? {status:'점장반려',manager_status:'반려',manager_rejected_by:user.name,manager_rejected_at:new Date().toISOString(),reject_reason:memo}
        : {status:'최종반려',final_status:'반려',final_rejected_by:user.name,final_rejected_at:new Date().toISOString(),reject_reason:memo};
      const {error}=await supabase.from('freepass_requests').update(patch).eq('id',row.id);
      if(error) throw error;
      await writeAuditLog(mode==='manager'?'프리패스점장반려':'프리패스최종반려','freepass_requests',row.id,user,memo);
      alert('반려 처리되었습니다.');
      setSelected(null);
      load();
    }catch(e){
      askErrorReport({user,currentTab:'프리패스 승인',actionName:'반려',error:e});
    }
  }

  return (
    <div className="sectionCard freepassApprovalPanel">
      <h3>{mode==='manager'?'점장 승인 대기':'최종 승인 대기'}</h3>
      <p className="muted approvalListHint">승인 대기 목록을 누르면 상세 확인 후 승인/반려할 수 있습니다.</p>
      <div className="freepassApprovalTableWrap">
        <table className="freepassApprovalTable">
          <thead><tr><th>신청자</th><th>매장</th><th>유형</th><th>일자</th><th>시간</th><th>사유</th><th>상태</th></tr></thead>
          <tbody>
            {rows.map(r=><tr key={r.id} className="clickableRow" onClick={()=>setSelected(r)}>
              <td>{r.employee_name}</td>
              <td>{r.employee_store}</td>
              <td>{displayRequestType(r)} {r.use_type||''}</td>
              <td>{r.request_date}</td>
              <td>{r.hours}시간</td>
              <td>{r.reason}</td>
              <td>{r.status}</td>
            </tr>)}
            {loading&&<tr className="approvalEmptyRow"><td colSpan="7"><InlineLoadingState /></td></tr>}
            {!loading&&!rows.length&&<tr className="approvalEmptyRow"><td colSpan="7"><EmptyStateText>승인 대기 건이 없습니다.</EmptyStateText></td></tr>}
          </tbody>
        </table>
      </div>

      <div className="mobileCardList freepassMobileApprovalList">
        {loading && <InlineLoadingState />}
        {!loading && rows.map(r => (
          <MobileInfoCard
            key={r.id}
            title={r.employee_name}
            subtitle={`${r.employee_store || '-'} · ${displayRequestType(r)} ${r.use_type || ''}`}
            meta={[r.request_date, `${r.hours}시간`, r.reason || '-']}
            status={pushStatusLabel(r.status)}
            badgeClass={pushStatusClass(r.status)}
            onClick={() => setSelected(r)}
          />
        ))}
        {!loading && !rows.length && <EmptyStateText>승인 대기 건이 없습니다.</EmptyStateText>}
      </div>

      {selected && createPortal(<div className="modalBg freepassApprovalModalBg">
        <div className="modal freepassApprovalModal">
          <div className="modalHead">
            <h2>프리패스 승인 상세</h2>
            <button onClick={()=>setSelected(null)}>닫기</button>
          </div>
          <div className="freepassApprovalModalBody compactApprovalBody">
            <section className="infoGrid">
              <p><b>신청자</b><br/>{selected.employee_name}</p>
              <p><b>유형</b><br/>{displayRequestType(selected)} {selected.use_type||''}</p>
              <p><b>일자</b><br/>{selected.request_date}</p>
              <p><b>시간</b><br/>{selected.hours}시간</p>
              <p><b>사유</b><br/>{selected.reason}</p>
              <p><b>동의</b><br/>{selected.consent_agreed ? `동의완료 ${selected.consent_agreed_at ? formatKST(selected.consent_agreed_at) : ''}` : '-'}</p>
            </section>
            {selected.consent_text && <div className="freepassConsentRecord"><b>동의 문구</b><p>{selected.consent_text}</p></div>}
            {selected.evidence_photo_data&&<div className="evidenceGrid large">{(() => { try { const arr = JSON.parse(selected.evidence_photo_data); return Array.isArray(arr) ? arr : [{data:selected.evidence_photo_data}]; } catch { return [{data:selected.evidence_photo_data}]; } })().map((p,idx)=><div className="evidenceItem" key={idx}><img className="evidencePreview large" src={p.data || p} alt={`증빙 ${idx+1}`} />{p.captured_at && <p>촬영일시: {freepassPhotoTimeLabel(p.captured_at)}</p>}</div>)}</div>}
          </div>
          <div className="reviewActions stickyApprovalActions freepassApprovalActions">
            <button className="primary" disabled={!!processingId} onClick={()=>approve(selected)}>{processingId===selected.id?'처리 중':'승인'}</button>
            <button className="dangerBtn" disabled={!!processingId} onClick={()=>reject(selected)}>반려</button>
          </div>
        </div>
      </div>, document.body)}
    </div>
  );
}



function FreepassLogTab({ user }) {
  const [ledger,setLedger]=useState([]);
  const [requests,setRequests]=useState([]);
  const [employees,setEmployees]=useState([]);
  const [keyword,setKeyword]=useState('');
  const [storeFilter,setStoreFilter]=useState('전체');
  const [typeFilter,setTypeFilter]=useState('전체');
  const [loading,setLoading]=useState(true);
  const [processingId,setProcessingId]=useState(null);
  const [selectedLog, setSelectedLog] = useState(null);
  const [page,setPage]=useState(1);

  useEffect(()=>{ load(); },[]);

  async function load(){
    setLoading(true);
    try{
      const [ledgerRes, requestRes, empRes] = await Promise.all([
        runNetworkRead(() => supabase.from('freepass_ledger').select(FREEPASS_LEDGER_LIST_COLUMNS).order('created_at',{ascending:false})),
        runNetworkRead(() => supabase.from('freepass_requests').select(FREEPASS_REQUEST_LOG_COLUMNS).order('requested_at',{ascending:false})),
        runNetworkRead(() => supabase.from('employees').select('id,name,store_name,status,role').order('store_name'))
      ]);
      setLedger(ledgerRes.data || []);
      setRequests(requestRes.data || []);
      setEmployees(empRes.data || []);
      setPage(1);
    }catch(e){
      askErrorReport({user,currentTab:'프리패스 로그',actionName:'로그 조회',error:e});
    }finally{
      setLoading(false);
    }
  }

  function normalizeType(v){
    if(v === '야근 적립') return '고객 추가 응대';
    if(v === '휴무출근 적립' || v === '휴무 출근 적립') return '휴무 고객응대';
    return v || '-';
  }

  const requestMap = useMemo(()=>Object.fromEntries((requests||[]).map(r=>[r.id,r])), [requests]);

  const logs = useMemo(() => {
    const ledgerLogs = (ledger || []).map(r => ({
      id:`ledger-${r.id}`,
      at:r.created_at,
      requestedAt: freepassRequestedDateTimeLabel(r, requestMap),
      actualDate: freepassActualDateLabel(r),
      store:r.employee_store,
      employee:r.employee_name,
      type:freepassTypeLabel(r.type),
      hours:Number(r.hours || 0),
      detail:r.reason || '-',
      source:'프리패스 이력',
      actor:r.created_by || '-'
    }));
    const requestLogs = (requests || []).map(r => ({
      id:`request-${r.id}`,
      at:r.requested_at || r.created_at,
      requestedAt: formatKST(r.requested_at || r.created_at),
      actualDate: r.request_date || '-',
      store:r.employee_store,
      employee:r.employee_name,
      type:`신청/${normalizeType(r.request_type)}`,
      hours:Number(r.hours || 0),
      detail:`${r.status || '-'} · ${r.reason || '-'}`,
      source:'신청/승인',
      actor:r.final_approved_by || r.manager_approved_by || r.employee_name || '-'
    }));
    return [...ledgerLogs, ...requestLogs].sort((a,b)=>String(b.at||'').localeCompare(String(a.at||'')));
  }, [ledger, requests, requestMap]);

  const storeOptions = ['전체', ...new Set((employees||[]).map(e=>e.store_name).filter(Boolean))];

  const filtered = logs.filter(r => {
    if(storeFilter !== '전체' && r.store !== storeFilter) return false;
    if(typeFilter !== '전체' && !String(r.type).includes(typeFilter)) return false;
    const q = keyword.trim().toLowerCase();
    if(!q) return true;
    return `${r.store||''} ${r.employee||''} ${r.type||''} ${r.detail||''} ${r.actor||''}`.toLowerCase().includes(q);
  });
  useEffect(()=>{setPage(1);},[keyword,storeFilter,typeFilter]);
  const pageSize=100;
  const pageLogs=filtered.slice((page-1)*pageSize,page*pageSize);

  return (
    <div className="sectionCard freepassLogTab">
      <h3>프리패스 로그</h3>
      <div className="freepassLogFilters">
        <input value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder="직원/매장/사유/승인자 검색" />
        <select value={storeFilter} onChange={e=>setStoreFilter(e.target.value)}>{storeOptions.map(s=><option key={s}>{s}</option>)}</select>
        <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}>
          <option>전체</option>
          <option>적립</option>
          <option>사용</option>
          <option>월차전환</option>
          <option>차감</option>
          <option>신청</option>
        </select>
      </div>
      <table className="freepassLogTable">
        <thead><tr><th>유형</th><th>시간</th><th>요청일시</th><th>실제일</th><th>매장</th><th>직원</th><th>내용</th><th>처리자</th></tr></thead>
        <tbody>
          {loading && <tr><td colSpan="8"><InlineLoadingState /></td></tr>}
            {!loading && pageLogs.map(r=><tr key={r.id}>
            <td>{r.type}</td>
            <td>{freepassLedgerSignedHours(r)}시간</td>
            <td>{r.requestedAt || formatKST(r.at)}</td>
            <td>{r.actualDate || '-'}</td>
            <td>{r.store || '-'}</td>
            <td>{r.employee || '-'}</td>
            <td className="freepassReasonCell">{r.detail}</td>
            <td>{r.actor}</td>
          </tr>)}
          {!loading && !filtered.length && <tr><td colSpan="8" className="muted">표시할 로그가 없습니다.</td></tr>}
        </tbody>
      </table>
      <div className="mobileCardList freepassMobileLogList">
        {loading && <InlineLoadingState />}
        {!loading && pageLogs.map(r => (
          <MobileInfoCard
            key={r.id}
            title={`${r.employee || '-'} · ${r.type}`}
            subtitle={`${r.store || '-'} · ${freepassLedgerSignedHours(r)}시간`}
            meta={[r.requestedAt || formatKST(r.at), r.actualDate || '-', r.detail]}
            status={r.source}
            badgeClass="finalWaiting"
          />
        ))}
        {!loading && !filtered.length && <EmptyStateText>표시할 로그가 없습니다.</EmptyStateText>}
      </div>
      <PaginationBar total={filtered.length} page={page} onPageChange={setPage} pageSize={pageSize} />
    </div>
  );
}

function FreepassLimitSettings({ user }) {
  const [limit,setLimit]=useState(10);
  const [busy,setBusy]=useState(false);

  useEffect(()=>{ getFreepassMonthlyLimit().then(setLimit); },[]);

  async function save(){
    if(!isSuperAdmin(user)) return alert('최고관리자만 변경할 수 있습니다.');
    if(Number(limit) <= 0) return alert('월 사용 한도는 1시간 이상이어야 합니다.');
    setBusy(true);
    try{
      const {error}=await supabase.from('system_settings').upsert({
        key:'freepass_monthly_limit',
        value:String(limit),
        description:'프리패스 월 사용 한도',
        updated_by:user.name
      }, { onConflict:'key' });
      if(error) throw error;
      await writeAuditLog('프리패스월한도변경','system_settings','freepass_monthly_limit',user,`${limit}시간`);
      alert('월 프리패스 사용 한도가 변경되었습니다.');
    }catch(e){
      askErrorReport({user,currentTab:'프리패스',actionName:'월 사용 한도 변경',error:e});
    }finally{
      setBusy(false);
    }
  }

  return (
    <div className="sectionCard">
      <h3>월 프리패스 사용 한도 설정</h3>
      <p className="muted">직원 1인이 한 달에 사용할 수 있는 프리패스 최대 시간을 변경합니다. 월차 전환은 제외됩니다.</p>
      <div className="formGrid">
        <label>월 사용 한도
          <input type="number" min="1" step="1" value={limit} onChange={e=>setLimit(e.target.value)} />
        </label>
      </div>
      <button className="primary" disabled={busy} onClick={save}>한도 저장</button>
    </div>
  );
}

function FreepassAdminAdjust({ user }) {
  const [employees,setEmployees]=useState([]);
  const [employeeName,setEmployeeName]=useState('');
  const [type,setType]=useState('적립');
  const [hours,setHours]=useState(1);
  const [reason,setReason]=useState('');
  const [bulkRows,setBulkRows]=useState({});
  const [bulkReason,setBulkReason]=useState('');
  const [bulkType,setBulkType]=useState('적립');
  const [bulkHours,setBulkHours]=useState(1);
  const [bulkIndividual,setBulkIndividual]=useState(false);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);

  useEffect(()=>{ load(); },[]);

  async function load(){
    setLoading(true);
    const {data}=await supabase.from('employees').select('*').eq('status','재직').order('store_name');
    const sorted=sortEmployeesForLogin(data||[]);
    setEmployees(sorted);
    const initial={};
    sorted.forEach(e=>{ initial[e.id||e.name]={checked:false,type:'적립',hours:''}; });
    setBulkRows(initial);
    setLoading(false);
  }

  async function save(){
    if(!isSuperAdmin(user)) return alert('최고관리자만 조정할 수 있습니다.');
    if(!employeeName) return alert('직원을 선택해주세요.');
    if(!reason.trim()) return alert('사유를 입력해주세요.');
    const emp=employees.find(e=>e.name===employeeName);
    const value=(type==='차감'||type==='사용처리')?-Math.abs(Number(hours)):Math.abs(Number(hours));
    try{
      const {error}=await supabase.from('freepass_ledger').insert({employee_id:emp?.id||null,employee_name:employeeName,employee_store:emp?.store_name||'',type,hours:value,reason,effective_date:todayLocalISO(),created_by:user.name});
      if(error) throw error;
      await writeAuditLog('프리패스관리자조정','freepass_ledger',employeeName,user,`${type} ${value}시간 / ${reason}`);
      alert('조정 완료');
      setReason('');
    }catch(e){ askErrorReport({user,currentTab:'프리패스',actionName:'관리자 조정',error:e}); }
  }

  function updateBulkRow(key,patch){ setBulkRows(prev=>({...prev,[key]:{...(prev[key]||{}),...patch}})); }
  function selectAllBulk(checked){
    const next={};
    employees.forEach(e=>{ const key=e.id||e.name; next[key]={...(bulkRows[key]||{type:'적립',hours:0}),checked}; });
    setBulkRows(next);
  }

  async function saveBulk(){
    if(!isSuperAdmin(user)) return alert('최고관리자만 일괄 조정할 수 있습니다.');
    if(!bulkReason.trim()) return alert('일괄 처리 사유를 입력해주세요.');
    if(!bulkIndividual && Number(bulkHours||0)<=0) return alert('공통 시간을 입력해주세요.');
    const selected=employees.map(emp=>({emp,row:bulkRows[emp.id||emp.name]||{}})).filter(x=>x.row.checked && (!bulkIndividual || Number(x.row.hours||0)>0));
    if(!selected.length) return alert('일괄 처리할 직원을 선택해주세요.');
    if(!confirm(`${selected.length}명 프리패스를 ${bulkIndividual ? '개별 시간' : `${bulkType} ${bulkHours}시간`} 기준으로 일괄 처리합니다.\n진행할까요?`)) return;
    setBusy(true);
    try{
      const rows=selected.map(({emp,row})=>{
        const t=bulkIndividual ? (row.type||bulkType||'적립') : bulkType;
        const h=Math.abs(Number(bulkIndividual ? row.hours : bulkHours));
        return {employee_id:emp.id||null,employee_name:emp.name,employee_store:emp.store_name||'',type:t,hours:(t==='차감'||t==='사용처리')?-h:h,reason:bulkReason,effective_date:todayLocalISO(),created_by:user.name};
      });
      const {error}=await supabase.from('freepass_ledger').insert(rows);
      if(error) throw error;
      await writeAuditLog('프리패스일괄조정','freepass_ledger','bulk',user,`${rows.length}명 / ${bulkReason}`);
      alert(`일괄 처리 완료: ${rows.length}명`);
      setBulkReason('');
      const reset={}; employees.forEach(e=>{reset[e.id||e.name]={checked:false,type:bulkType,hours:''};});
      setBulkRows(reset);
    }catch(e){ askErrorReport({user,currentTab:'프리패스',actionName:'일괄 조정',error:e}); }
    finally{ setBusy(false); }
  }

  return (
    <div>
      <div className="sectionCard">
        <h3>개별 적립/차감/사용처리</h3>
        <div className="formGrid">
          <select value={employeeName} onChange={e=>setEmployeeName(e.target.value)}>
            <option value="">직원 선택</option>
            {employees.map(e=><option key={e.id||e.name} value={e.name}>{e.store_name} · {e.name}</option>)}
          </select>
          <select value={type} onChange={e=>setType(e.target.value)}><option>적립</option><option>차감</option><option>사용처리</option></select>
          <input type="number" min="1" step="1" value={hours} onChange={e=>setHours(e.target.value)}/>
        </div>
        <textarea value={reason} onChange={e=>setReason(e.target.value)} placeholder="사유 입력"/>
        <button className="primary" onClick={save}>저장</button>
      </div>

      <div className="sectionCard">
        <h3>전직원 일괄 적립/차감/사용처리</h3>
        <p className="muted">직원을 체크하고 적립/차감/사용처리 시간과 사유를 입력하면 한 번에 처리됩니다. 직원 순서는 로그인 화면과 동일합니다.</p>
        <div className="bulkControlPanel">
          <div className="bulkActions">
            <button type="button" onClick={()=>selectAllBulk(true)}>전체 선택</button>
            <button type="button" onClick={()=>selectAllBulk(false)}>전체 해제</button>
          </div>
          <div className="bulkCommonInputs">
            <label>공통 구분
              <select value={bulkType} onChange={e=>setBulkType(e.target.value)}><option>적립</option><option>차감</option><option>사용처리</option></select>
            </label>
            <label>공통 시간
              <input type="number" min="1" step="1" value={bulkHours} onChange={e=>setBulkHours(e.target.value)} />
            </label>
            <label className="bulkIndividualToggle">
              <input type="checkbox" checked={bulkIndividual} onChange={e=>setBulkIndividual(e.target.checked)} />
              직원별 개별 시간 사용
            </label>
          </div>
        </div>
        <textarea value={bulkReason} onChange={e=>setBulkReason(e.target.value)} placeholder="일괄 처리 사유 입력" />
        <table className="freepassBulkTable compactFreepassTable">
          <thead><tr><th>선택</th><th>매장</th><th>직원</th><th>권한</th>{bulkIndividual && <><th>구분</th><th>시간</th></>}</tr></thead>
          <tbody>
            {loading && <tr className="approvalEmptyRow"><td colSpan={bulkIndividual ? 6 : 4}><InlineLoadingState /></td></tr>}
            {!loading && !employees.length && <tr className="approvalEmptyRow"><td colSpan={bulkIndividual ? 6 : 4}><EmptyStateText>표시할 직원이 없습니다.</EmptyStateText></td></tr>}
            {!loading && employees.map(emp=>{
              const key=emp.id||emp.name; const row=bulkRows[key]||{};
              return <tr key={key}>
                <td><input type="checkbox" checked={!!row.checked} onChange={e=>updateBulkRow(key,{checked:e.target.checked})}/></td>
                <td>{emp.store_name}</td><td>{emp.name}</td><td>{emp.role||'직원'}</td>
                {bulkIndividual && <>
                  <td><select value={row.type||bulkType} onChange={e=>updateBulkRow(key,{type:e.target.value})}><option>적립</option><option>차감</option><option>사용처리</option></select></td>
                  <td><input type="number" min="0" step="1" value={row.hours??''} placeholder={String(bulkHours)} onChange={e=>updateBulkRow(key,{hours:e.target.value})}/></td>
                </>}
              </tr>
            })}
          </tbody>
        </table>
        <button className="primary" disabled={busy} onClick={saveBulk}>일괄 처리 저장</button>
      </div>
    </div>
  );
}


function FreepassStoreOverview({ user }) {
  const [ledger,setLedger]=useState([]);
  const [employees,setEmployees]=useState([]);
  const [selected,setSelected]=useState(null);
  const [requests,setRequests]=useState([]);
  const [loading,setLoading]=useState(true);
  const [processingId,setProcessingId]=useState(null);
  const [selectedLog, setSelectedLog] = useState(null);

  useEffect(()=>{ load(); },[]);

  async function load(){
    setLoading(true);
    try{
      const [ledgerRes, reqRes, empRes] = await Promise.all([
        runNetworkRead(() => supabase.from('freepass_ledger').select(FREEPASS_LEDGER_LIST_COLUMNS).order('created_at',{ascending:false})),
        runNetworkRead(() => supabase.from('freepass_requests').select(FREEPASS_REQUEST_LOG_COLUMNS).order('requested_at',{ascending:false})),
        runNetworkRead(() => supabase.from('employees').select('id,name,store_name,status,role').eq('status','재직').order('name'))
      ]);
      const e = empRes.data || [];
      const visibleEmployees = isAdminLike(user) ? e : e.filter(emp => emp.store_name === user.store_name);
      setLedger(ledgerRes.data||[]);
      setRequests(reqRes.data||[]);
      setEmployees(visibleEmployees);
    }catch(e){
      askErrorReport({user,currentTab:'프리패스 전체현황',actionName:'전체현황 조회',error:e});
    }finally{
      setLoading(false);
    }
  }

  const rows = sortEmployeesForLogin(employees);

  const selectedRows = selected ? ledger.filter(r => r.employee_name === selected.name) : [];
  const requestMap = useMemo(()=>Object.fromEntries((requests||[]).map(r=>[r.id,r])), [requests]);

  return (
    <div className="sectionCard freepassStoreOverviewCard">
      <h3>{isAdminLike(user) ? '매장 직원 프리패스 현황' : `${user.store_name} 프리패스 현황`}</h3>
      <p className="muted">직원을 누르면 적립/사용/차감/초기화 이력을 확인할 수 있습니다.</p>
      <table className="freepassOverviewTable compactFreepassTable">
        <thead>
          <tr><th>매장</th><th>직원</th><th>권한</th><th>잔여시간</th><th>이번달 사용</th></tr>
        </thead>
        <tbody>
          {rows.map(emp=>{
            const balance = freepassBalanceOf(ledger, emp.name);
            const used = freepassUsedInMonth(ledger, emp.name);
            return (
              <tr key={emp.id||emp.name} className="clickableRow" onClick={()=>setSelected(emp)}>
                <td>{emp.store_name}</td>
                <td>{emp.name}</td>
                <td>{emp.role || '직원'}</td>
                <td><span className={`balanceBadge ${balance < 0 ? 'negative' : balance === 0 ? 'zero' : 'positive'}`}>{balance}시간</span></td>
                <td>{used}시간</td>
              </tr>
            );
          })}
          {loading && <tr><td colSpan="5"><InlineLoadingState /></td></tr>}
          {!loading && !rows.length && <tr className="approvalEmptyRow"><td colSpan="5"><EmptyStateText>표시할 직원이 없습니다.</EmptyStateText></td></tr>}
        </tbody>
      </table>

      <div className="mobileCardList freepassMobileOverviewList">
        {loading && <InlineLoadingState />}
        {!loading && rows.map(emp => {
          const balance = freepassBalanceOf(ledger, emp.name);
          const used = freepassUsedInMonth(ledger, emp.name);
          return (
            <MobileInfoCard
              key={emp.id || emp.name}
              title={emp.name}
              subtitle={`${emp.store_name || '-'} · ${emp.role || '직원'}`}
              meta={[`잔여 ${balance}시간`, `이번달 사용 ${used}시간`]}
              status={`${balance}시간`}
              badgeClass={balance < 0 ? 'rejected' : balance === 0 ? 'waiting' : 'finalWaiting'}
              onClick={() => setSelected(emp)}
            />
          );
        })}
        {!loading && !rows.length && <EmptyStateText>표시할 직원이 없습니다.</EmptyStateText>}
      </div>

      {selected && (
        <div className="modalBg freepassHistoryModalBg">
          <div className="modal freepassHistoryModal">
            <div className="modalHead">
              <h2>{selected.name} 프리패스 이력</h2>
              <button onClick={()=>setSelected(null)}>닫기</button>
            </div>
            <div className="freepassHistoryBody">
            <section className="infoGrid">
              <p><b>매장</b><br />{selected.store_name}</p>
              <p><b>권한</b><br />{selected.role || '직원'}</p>
              <p><b>잔여시간</b><br />{freepassBalanceOf(ledger, selected.name)}시간</p>
              <p><b>이번달 사용</b><br />{freepassUsedInMonth(ledger, selected.name)}시간</p>
            </section>
            <section>
              <h3>적립/사용/차감 이력</h3>
              <div className="freepassHistoryTableScroll desktopFreepassHistoryTable">
              <table>
                <thead><tr><th>구분</th><th>시간</th><th>요청일시</th><th>실제일</th><th>사유</th><th>처리자</th></tr></thead>
                <tbody>
                  {selectedRows.map(r=>(
                    <tr key={r.id}>
                      <td>{freepassTypeLabel(r.type)}</td>
                      <td>{freepassLedgerSignedHours(r)>0?`+${freepassLedgerSignedHours(r)}`:freepassLedgerSignedHours(r)}시간</td>
                      <td>{freepassRequestedDateTimeLabel(r, requestMap)}</td>
                      <td>{freepassActualDateLabel(r)}</td>
                      <td className="freepassReasonCell">{r.reason || '-'}</td>
                      <td>{r.created_by || '-'}</td>
                    </tr>
                  ))}
                  {!selectedRows.length && <tr><td colSpan="6" className="muted">프리패스 이력이 없습니다.</td></tr>}
                </tbody>
              </table>
              </div>
              <div className="mobileCardList freepassHistoryMobileList">
                {selectedRows.map(r => {
                  const signedHours = freepassLedgerSignedHours(r);
                  return (
                    <div className="freepassHistoryCard" key={r.id}>
                      <div className="freepassHistoryCardHead">
                        <strong>{freepassTypeLabel(r.type)}</strong>
                        <span className={signedHours < 0 ? 'negative' : 'positive'}>{signedHours > 0 ? `+${signedHours}` : signedHours}시간</span>
                      </div>
                      <p>{freepassRequestedDateTimeLabel(r, requestMap)}</p>
                      <p>{freepassActualDateLabel(r)} · {r.created_by || '-'}</p>
                      <div>{r.reason || '-'}</div>
                    </div>
                  );
                })}
                {!selectedRows.length && <EmptyStateText>프리패스 이력이 없습니다.</EmptyStateText>}
              </div>
            </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FreepassSemiannualReset({ user }) {
  const [ledger,setLedger]=useState([]);
  const [employees,setEmployees]=useState([]);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [exceptions,setExceptions]=useState({});

  useEffect(()=>{ load(); },[]);
  async function load(){
    setLoading(true);
    const {data:l}=await supabase.from('freepass_ledger').select('*').order('created_at',{ascending:false});
    const {data:e}=await supabase.from('employees').select('*').eq('status','재직').order('store_name');
    setLedger(l||[]);
    const sorted=sortEmployeesForLogin(e||[]);
    setEmployees(sorted);
    const init={}; sorted.forEach(emp=>{ init[emp.id||emp.name]=false; });
    setExceptions(init);
    setLoading(false);
  }

  const resetTargets = employees.map(emp => ({...emp, balance: freepassBalanceOf(ledger, emp.name)})).filter(emp => emp.balance > 0);
  const activeTargets = resetTargets.filter(emp => !exceptions[emp.id||emp.name]);

  function toggleException(key, checked){
    setExceptions(prev=>({...prev,[key]:checked}));
  }

  async function runReset(){
    if(!isSuperAdmin(user)) return alert('최고관리자만 실행할 수 있습니다.');
    if(!confirm(`잔여 프리패스 ${activeTargets.length}명을 0으로 초기화합니다.\n예외 선택된 인원은 초기화하지 않습니다.\n마이너스 잔여시간은 유지됩니다.\n진행할까요?`)) return;
    setBusy(true);
    try{
      const rows = activeTargets.map(emp => ({
        employee_id: emp.id || null,
        employee_name: emp.name,
        employee_store: emp.store_name,
        type: '반기초기화',
        hours: -Math.abs(Number(emp.balance)),
        reason: '6개월 단위 잔여 프리패스 초기화',
        effective_date: todayLocalISO(),
        created_by: user.name,
        reset_cycle: todayLocalISO().slice(0,7)
      }));
      if(rows.length){
        const {error}=await supabase.from('freepass_ledger').insert(rows);
        if(error) throw error;
      }
      await writeAuditLog('프리패스반기초기화','freepass_ledger','semiannual',user,`초기화 ${rows.length}명 / 예외 ${resetTargets.length-activeTargets.length}명`);
      alert('반기 초기화가 완료되었습니다.');
      load();
    }catch(e){
      askErrorReport({user,currentTab:'프리패스',actionName:'반기 초기화',error:e});
    }finally{
      setBusy(false);
    }
  }

  return (
    <div className="sectionCard freepassSemiannualCard">
      <h3>6개월 잔여 프리패스 초기화</h3>
      <p className="muted">잔여 프리패스만 0으로 초기화하고, 마이너스 잔여시간은 유지합니다. 예외 체크한 인원은 초기화하지 않습니다.</p>
      <button className="dangerBtn" disabled={busy} onClick={runReset}>잔여 프리패스 초기화 실행</button>
      <table className="freepassResetTable compactFreepassTable">
        <thead><tr><th>예외</th><th>매장</th><th>직원</th><th>현재 잔여</th><th>초기화 차감</th></tr></thead>
        <tbody>
          {loading && <tr className="approvalEmptyRow"><td colSpan="5"><InlineLoadingState /></td></tr>}
          {!loading && resetTargets.map(emp=>{
            const key=emp.id||emp.name;
            const except=!!exceptions[key];
            return (
              <tr key={key}>
                <td><input type="checkbox" checked={except} onChange={e=>toggleException(key,e.target.checked)} /></td>
                <td>{emp.store_name}</td>
                <td>{emp.name}</td>
                <td>{emp.balance}시간</td>
                <td>{except ? '예외' : `-${emp.balance}시간`}</td>
              </tr>
            );
          })}
          {!loading && !resetTargets.length && <tr className="approvalEmptyRow"><td colSpan="5"><div className="freepassStateBox">초기화 대상 잔여 프리패스가 없습니다.</div></td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function FreepassOverview({ user }) {
  const [ledger,setLedger]=useState([]),[employees,setEmployees]=useState([]);
  useEffect(()=>{ load(); },[]);
  async function load(){
    const [{data:l},{data:e}] = await Promise.all([
      runNetworkRead(() => supabase.from('freepass_ledger').select(FREEPASS_LEDGER_LIST_COLUMNS).order('created_at',{ascending:false})),
      runNetworkRead(() => supabase.from('employees').select('id,name,store_name,status,role').eq('status','재직').order('store_name'))
    ]);
    setLedger(l||[]);
    setEmployees(e||[]);
  }

  const rows = sortEmployeesForLogin(employees);

  return (
    <div className="sectionCard">
      <h3>전체 프리패스 현황</h3>
      <p className="muted">매장 순서 기준으로 잔여 시간을 확인합니다. 잔여 프리패스은 6개월마다 초기화 대상이며, 마이너스는 유지됩니다.</p>
      <table className="freepassOverviewTable compactFreepassTable">
        <thead>
          <tr><th>매장</th><th>직원</th><th>권한</th><th>잔여시간</th><th>이번달 사용</th></tr>
        </thead>
        <tbody>
          {rows.map(emp=>{
            const balance = freepassBalanceOf(ledger, emp.name);
            const used = freepassUsedInMonth(ledger, emp.name);
            return (
              <tr key={emp.id||emp.name}>
                <td>{emp.store_name}</td>
                <td>{emp.name}</td>
                <td>{emp.role || '직원'}</td>
                <td><span className={`balanceBadge ${balance < 0 ? 'negative' : balance === 0 ? 'zero' : 'positive'}`}>{balance}시간</span></td>
                <td>{used}시간</td>
              </tr>
            );
          })}
          {!rows.length && <tr><td colSpan="5" className="muted">직원 정보가 없습니다.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}



function PushSettings({ user }) {
  const [supported,setSupported]=useState(false);
  const [permission,setPermission]=useState(typeof Notification!=='undefined'?Notification.permission:'unsupported');
  const [subscriptionSaved,setSubscriptionSaved]=useState(false);
  const [busy,setBusy]=useState(false);

  useEffect(()=>{ setSupported(isPushSupported()); checkExistingSubscription(); },[]);

  async function checkExistingSubscription(){
    if(!isPushSupported()) return;
    try{
      const reg=await navigator.serviceWorker.getRegistration();
      const sub=await reg?.pushManager?.getSubscription?.();
      setSubscriptionSaved(!!sub);
    }catch{}
  }

  async function enablePush(){
    if(!isPushSupported()) return alert('현재 브라우저에서는 푸시 알림을 지원하지 않습니다. 크롬/엣지 또는 홈화면에 추가한 Safari 기준으로 사용해주세요.');
    setBusy(true);
    try{
      const result=await Notification.requestPermission();
      setPermission(result);
      if(result!=='granted') return alert('브라우저 알림 허용이 필요합니다.');
      const reg=await navigator.serviceWorker.register('/service-worker.js');
      const publicKey=import.meta.env.VITE_VAPID_PUBLIC_KEY || '';
      if(!publicKey) return alert('VITE_VAPID_PUBLIC_KEY 환경변수가 아직 설정되지 않았습니다. UI와 DB 구조는 준비되었습니다.');
      const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64ToUint8Array(publicKey)});
      const {error}=await supabase.from('push_subscriptions').upsert({
        employee_id:user.id, employee_name:user.name, employee_store:user.store_name,
        endpoint:sub.endpoint, subscription_json:JSON.stringify(sub), user_agent:navigator.userAgent,
        is_active:true
      },{onConflict:'endpoint'});
      if(error) throw error;
      setSubscriptionSaved(true);
      alert('브라우저 푸시 알림이 등록되었습니다.');
    }catch(e){ askErrorReport({user,currentTab:'알림 설정',actionName:'푸시 알림 등록',error:e}); }
    finally{ setBusy(false); }
  }

  async function saveTestNotification(){
    try{
      const {error}=await supabase.from('notification_requests').insert({
        employee_id:user.id, employee_name:user.name,
        title:'세찬컴퍼니 인트라넷 테스트 알림',
        body:`${user.name}님, 브라우저 푸시 알림 테스트 요청이 접수되었습니다.`,
        status:'대기', created_by:user.name
      });
      if(error) throw error;
      alert('테스트 알림 요청이 저장되었습니다. 실제 발송은 푸시 발송 함수 연결 후 작동합니다.');
    }catch(e){ askErrorReport({user,currentTab:'알림 설정',actionName:'테스트 알림 요청',error:e}); }
  }

  return <div className="sectionCard">
    <h3>브라우저 알림 설정</h3>
    <p className="muted">프리패스 승인/반려, 해피콜 반려 같은 알림을 브라우저 푸시로 받을 수 있도록 준비합니다.</p>
    <div className="pushStatusBox">
      <p><b>지원 여부</b> {supported?'지원 가능':'지원 불가'}</p>
      <p><b>브라우저 권한</b> {permission}</p>
      <p><b>구독 상태</b> {subscriptionSaved?'등록됨':'미등록'}</p>
    </div>
    <div className="reviewActions"><button className="primary" onClick={enablePush} disabled={busy}>알림 허용/등록</button><button onClick={saveTestNotification}>테스트 알림 요청</button></div>
    <p className="muted smallText">아이폰은 Safari에서 홈 화면에 추가한 웹앱 기준으로 안정적이며, 카카오톡 인앱브라우저에서는 제한될 수 있습니다.</p>
  </div>;
}



function AccessoryOrdersPage({ user }) {
  const categories = ['케이스','필름','충전기','보조배터리','기타'];
  const orderSources = ['개통','기존고객','워크인 고객'];
  const returnReasons = ['고객 변심','상품 불량','주문 실수','재고 오류','기타'];
  const emptyItem = () => ({ model_name:'', category:'케이스', item_name:'', price:'' });

  const [rows,setRows]=useState([]);
  const [active,setActive]=useState('pending');
  const [scope,setScope]=useState('mine');
  const [storeFilter,setStoreFilter]=useState('');
  const [employeeFilter,setEmployeeFilter]=useState('');
  const [categoryFilter,setCategoryFilter]=useState('');
  const [sourceFilter,setSourceFilter]=useState('');
  const [search,setSearch]=useState('');
  const [newOrder,setNewOrder]=useState({ customer_name:'', order_source:'개통', payment_type:'무료제공', customer_payment_amount:'', items:[emptyItem()] });
  const [editingId,setEditingId]=useState(null);
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [statusModal,setStatusModal]=useState(null);
  const [statusDraft,setStatusDraft]=useState({next:'', expected_arrival_date:'', return_reason:'고객 변심', return_reason_extra:''});

  const isAdmin = isAdminLike(user);
  const canSeeAll = isAdmin;

  useEffect(()=>{ load(); },[]);

  async function load(){
    setLoading(true);
    try{
      const {data,error}=await supabase.from('accessory_orders').select('*').order('created_at',{ascending:false});
      if(error) throw error;
      setRows(data||[]);
    }catch(e){
      console.warn('accessory_orders load failed', e);
      askErrorReport?.({user,currentTab:'악세사리 주문',actionName:'주문 목록 불러오기',error:e});
    }finally{
      setLoading(false);
    }
  }

  function availableScopes(){
    const list = [{key:'mine', label:'내 주문'}, {key:'store', label:'매장 현황'}];
    if (canSeeAll) list.push({key:'all', label:'전체 현황'});
    return list;
  }

  function baseRowsByScope(targetScope = scope){
    if (targetScope === 'mine') return rows.filter(r => r.employee_name === user.name);
    if (targetScope === 'store') return rows.filter(r => r.store_name === user.store_name);
    if (targetScope === 'all' && canSeeAll) return rows;
    return rows.filter(r => r.employee_name === user.name);
  }

  function rowMatchesStatus(row, status) {
    if (status === 'pending') return !row.order_completed && !row.store_arrived && !row.customer_received && !row.is_returned;
    if (status === 'completed') return row.order_completed && !row.store_arrived && !row.customer_received && !row.is_returned;
    if (status === 'arrived') return row.store_arrived && !row.customer_received && !row.is_returned;
    if (status === 'received') return row.customer_received && !row.is_returned;
    if (status === 'returned') return row.is_returned;
    return true;
  }

  function overdueDays(dateStr){
    if(!dateStr) return 0;
    const today = new Date(); today.setHours(0,0,0,0);
    const d = new Date(`${dateStr}T00:00:00`);
    const diff = Math.floor((today - d)/(1000*60*60*24));
    return diff > 0 ? diff : 0;
  }

  function visibleRows(){
    let list = baseRowsByScope(scope);
    if (storeFilter && scope === 'all') list = list.filter(r => r.store_name === storeFilter);
    if (employeeFilter) list = list.filter(r => r.employee_name === employeeFilter);
    if (sourceFilter) list = list.filter(r => r.order_source === sourceFilter);
    if (categoryFilter) list = list.filter(r => normalizeAccessoryItems(r).some(item => item.category === categoryFilter));
    const q = search.trim().toLowerCase();
    if(q){
      list = list.filter(r => {
        const itemsText = normalizeAccessoryItems(r).map(i=>`${i.model_name||''} ${i.category||''} ${i.item_name||''}`).join(' ');
        return `${r.order_code||''} ${r.customer_name_masked||''} ${r.model_name||''} ${r.item_name||''} ${itemsText}`.toLowerCase().includes(q);
      });
    }
    return list.filter(r => rowMatchesStatus(r, active));
  }

  const activeBaseRows = baseRowsByScope(scope);
  const counts = {
    pending: activeBaseRows.filter(r=>rowMatchesStatus(r,'pending')).length,
    completed: activeBaseRows.filter(r=>rowMatchesStatus(r,'completed')).length,
    arrived: activeBaseRows.filter(r=>rowMatchesStatus(r,'arrived')).length,
    received: activeBaseRows.filter(r=>rowMatchesStatus(r,'received')).length,
    returned: activeBaseRows.filter(r=>rowMatchesStatus(r,'returned')).length,
  };

  const filtered = visibleRows();
  const sumPrice = (list) => list.reduce((s,r)=>s+Number(r.price||0),0);
  const sumPayment = (list) => list.reduce((s,r)=>s+Number(r.customer_payment_amount||0),0);
  const filteredAmount = sumPrice(filtered);
  const filteredPayment = sumPayment(filtered);
  const filteredProfit = filteredPayment - filteredAmount;
  const employeeOptions = [...new Set(baseRowsByScope(scope).map(r=>r.employee_name).filter(Boolean))];
  const storeOptions = [...new Set(rows.map(r=>r.store_name).filter(Boolean))];

  function updateItem(idx, patch){ setNewOrder(prev=>({...prev, items:prev.items.map((item,i)=>i===idx?{...item,...patch}:item)})); }
  function addItem(){ setNewOrder(prev=>({...prev, items:[...prev.items, emptyItem()]})); }
  function removeItem(idx){ setNewOrder(prev=>({...prev, items:prev.items.length<=1?prev.items:prev.items.filter((_,i)=>i!==idx)})); }

  const orderTotal = newOrder.items.reduce((s,item)=>s+Number(item.price||0),0);
  const paymentAmount = newOrder.payment_type === '무료제공' ? 0 : Number(newOrder.customer_payment_amount || 0);

  async function generateOrderCode(){
    const now = new Date(); const mm = String(now.getMonth()+1).padStart(2,'0'); const dd = String(now.getDate()).padStart(2,'0');
    const prefix = `${mm}${dd}`;
    const {data,error}=await supabase.from('accessory_orders').select('order_code').like('order_code', `${prefix}%`);
    if(error) throw error;
    const maxNo = (data||[]).map(r=>Number(String(r.order_code||'').slice(4))).filter(n=>Number.isFinite(n)).reduce((a,b)=>Math.max(a,b),0);
    return `${prefix}${String(maxNo+1).padStart(2,'0')}`;
  }

  function cleanPayloadItems(){
    return newOrder.items.map(item=>({ model_name:String(item.model_name||'').trim(), category:item.category, item_name:String(item.item_name||'').trim(), price:Number(item.price||0) })).filter(item=>item.model_name && item.item_name && item.price>0);
  }

  async function createOrder(e){
    e.preventDefault();
    const cleanItems = cleanPayloadItems();
    if(!newOrder.customer_name.trim()) return alert('고객명을 입력해주세요.');
    if(!cleanItems.length) return alert('품목별 모델명, 품목 상세명, 금액을 1개 이상 입력해주세요.');
    setBusy(true);
    try{
      const code = await generateOrderCode();
      const masked = maskCustomerName(newOrder.customer_name);
      const itemSummary = cleanItems.map(item=>item.item_name).join(', ');
      const modelSummary = [...new Set(cleanItems.map(item=>item.model_name))].join(', ');
      const total = cleanItems.reduce((s,item)=>s+Number(item.price||0),0);
      const payload = {
        order_code: code, customer_name_masked: masked, model_name: modelSummary,
        category: cleanItems.length === 1 ? cleanItems[0].category : '기타', item_name: itemSummary, items_json: cleanItems,
        price: total, customer_payment_amount: newOrder.payment_type === '무료제공' ? null : Number(newOrder.customer_payment_amount || 0), payment_type: newOrder.payment_type,
        order_source: newOrder.order_source, employee_id: user.id || null, employee_name: user.name, store_name: user.store_name,
        order_completed: false, store_arrived: false, customer_received: false, is_returned: false,
        status_history: [{at:new Date().toISOString(), by:user.name, action:'주문 생성'}], created_by: user.name
      };
      const {error}=await supabase.from('accessory_orders').insert(payload);
      if(error) throw error;
      await writeAuditLog('악세사리주문생성','accessory_orders',code,user,`${masked} / ${modelSummary} / ${itemSummary} / ${formatKRW(total)}`);
      setNewOrder({customer_name:'', order_source:'개통', payment_type:'무료제공', customer_payment_amount:'', items:[emptyItem()]});
      setActive('pending'); alert(`주문건이 생성되었습니다.\n주문번호: ${code}`); load();
    }catch(e){ askErrorReport?.({user,currentTab:'악세사리 주문',actionName:'주문 생성',error:e}); alert(`주문 생성 실패: ${e.message || e}`);
    }finally{ setBusy(false); }
  }

  function beginEdit(row){
    const items = normalizeAccessoryItems(row).map(item=>({ model_name:item.model_name || row.model_name || '', category:item.category || '기타', item_name:item.item_name || '', price:item.price || '' }));
    setEditingId(row.id);
    setNewOrder({ customer_name: row.customer_name_masked || '', order_source: row.order_source || '개통', payment_type: row.payment_type || (row.customer_payment_amount ? '후불' : '무료제공'), customer_payment_amount: row.customer_payment_amount || '', items: items.length ? items : [emptyItem()] });
    window.scrollTo({top:0, behavior:'smooth'});
  }

  async function saveEdit(e){
    e.preventDefault(); const row = rows.find(r=>r.id===editingId); if(!row) return;
    const cleanItems = cleanPayloadItems(); if(!cleanItems.length) return alert('품목별 모델명, 품목 상세명, 금액을 1개 이상 입력해주세요.');
    setBusy(true);
    try{
      const itemSummary = cleanItems.map(item=>item.item_name).join(', ');
      const modelSummary = [...new Set(cleanItems.map(item=>item.model_name))].join(', ');
      const total = cleanItems.reduce((s,item)=>s+Number(item.price||0),0);
      const {error}=await supabase.from('accessory_orders').update({
        model_name:modelSummary, category: cleanItems.length === 1 ? cleanItems[0].category : '기타', item_name:itemSummary, items_json:cleanItems, price:total,
        customer_payment_amount: newOrder.payment_type === '무료제공' ? null : Number(newOrder.customer_payment_amount || 0), payment_type:newOrder.payment_type, order_source:newOrder.order_source, updated_by:user.name
      }).eq('id', editingId);
      if(error) throw error;
      await writeAuditLog('악세사리주문수정','accessory_orders',row.order_code,user,itemSummary);
      setEditingId(null); setNewOrder({customer_name:'', order_source:'개통', payment_type:'무료제공', customer_payment_amount:'', items:[emptyItem()]}); load();
    }catch(e){ askErrorReport?.({user,currentTab:'악세사리 주문',actionName:'주문 수정',error:e}); alert(`수정 실패: ${e.message || e}`);
    }finally{ setBusy(false); }
  }

  async function updateOrder(row, patch, actionName, detail=''){
    setBusy(true);
    try{
      const prevHist = Array.isArray(row.status_history) ? row.status_history : [];
      const nextHist = [...prevHist, {at:new Date().toISOString(), by:user.name, action:actionName.replace('악세사리',''), detail}];
      const {error}=await supabase.from('accessory_orders').update({...patch, status_history:nextHist, updated_by:user.name}).eq('id', row.id);
      if(error) throw error;
      await writeAuditLog(actionName,'accessory_orders',row.order_code,user,detail); load();
    }catch(e){ askErrorReport?.({user,currentTab:'악세사리 주문',actionName,error:e}); alert(`처리 실패: ${e.message || e}`);
    }finally{ setBusy(false); }
  }

  
function statusOptionsFor(row){
    const current = accessoryStatusKey(row);
    if(current === 'pending') return ['주문 완료','반품'];
    if(current === 'completed') return ['매장 도착','반품'];
    if(current === 'arrived') return ['고객 수령','반품'];
    if(current === 'received') return ['반품'];
    return [];
  }

  function handleStatusChange(row){
    const options = statusOptionsFor(row);
    if(!options.length) return alert('변경 가능한 상태가 없습니다.');
    setStatusModal(row);
    setStatusDraft({
      next: options[0],
      expected_arrival_date: row.expected_arrival_date || todayLocalISO(),
      return_reason:'고객 변심',
      return_reason_extra:''
    });
  }

  function closeStatusModal(){
    setStatusModal(null);
    setStatusDraft({next:'', expected_arrival_date:'', return_reason:'고객 변심', return_reason_extra:''});
  }

  async function submitStatusModal(){
    if(!statusModal) return;
    const choice = statusDraft.next;
    if(!choice) return alert('변경할 상태를 선택해주세요.');
    const row = statusModal;
    if(choice === '주문 완료'){
      if(!statusDraft.expected_arrival_date) return alert('도착 예정일을 선택해주세요.');
      await updateOrder(row,{order_completed:true, order_completed_at:new Date().toISOString(), expected_arrival_date:statusDraft.expected_arrival_date},'악세사리주문완료',`도착 예정일 ${statusDraft.expected_arrival_date}`);
      return closeStatusModal();
    }
    if(choice === '매장 도착'){
      await updateOrder(row,{store_arrived:true, store_arrived_at:new Date().toISOString()},'악세사리매장도착',row.customer_name_masked);
      return closeStatusModal();
    }
    if(choice === '고객 수령'){
      await updateOrder(row,{customer_received:true, customer_received_at:new Date().toISOString()},'악세사리고객수령',row.customer_name_masked);
      return closeStatusModal();
    }
    if(choice === '반품'){
      const reason = statusDraft.return_reason === '기타'
        ? (statusDraft.return_reason_extra.trim() || '기타')
        : statusDraft.return_reason;
      await updateOrder(row,{is_returned:true, returned_at:new Date().toISOString(), return_reason:reason},'악세사리반품',reason);
      return closeStatusModal();
    }
  }

  function showHistory(row){
    const hist = Array.isArray(row.status_history) ? row.status_history : [];
    if(!hist.length) return alert('상태 변경 이력이 없습니다.');
    alert(hist.map(h=>`${String(h.at||'').replace('T',' ').slice(0,16)}\n${h.by||'-'} · ${h.action||'-'}${h.detail?`\n${h.detail}`:''}`).join('\n\n'));
  }

  async function deleteOrder(row){
    if(row.customer_received && !isAdmin) return alert('고객 수령 완료건은 관리자만 삭제할 수 있습니다.');
    if(row.employee_name !== user.name && !isAdmin) return alert('내 주문건만 삭제할 수 있습니다.');
    if(!confirm(`주문건 ${row.order_code}을 삭제할까요?\n삭제 후 목록에서 보이지 않습니다.`)) return;
    setBusy(true);
    try{
      const {error}=await supabase.from('accessory_orders').delete().eq('id', row.id); if(error) throw error;
      await writeAuditLog('악세사리주문삭제','accessory_orders',row.order_code,user,row.customer_name_masked); load();
    }catch(e){ askErrorReport?.({user,currentTab:'악세사리 주문',actionName:'주문 삭제',error:e}); alert(`삭제 실패: ${e.message || e}`);
    }finally{ setBusy(false); }
  }

  return (
    <div className="accessoryModule">
      <h2>악세사리 주문 관리</h2>
      <div className="accessorySummaryGrid accessorySummaryCompact">
        <div className="accessoryStat"><span>주문 원가</span><strong>{formatKRW(filteredAmount)}</strong></div>
        <div className="accessoryStat"><span>수납 예정</span><strong>{formatKRW(filteredPayment)}</strong></div>
        <div className="accessoryStat"><span>예상 수익</span><strong>{formatKRW(filteredProfit)}</strong></div>
      </div>
      <div className="sectionCard accessoryFormCard">
        <h3>{editingId ? '주문건 수정' : '주문건 생성'}</h3>
        <form onSubmit={editingId ? saveEdit : createOrder}>
          <div className="accessoryFormGrid baseInfo">
            <label>고객명<input value={newOrder.customer_name} disabled={!!editingId} onChange={e=>setNewOrder(p=>({...p,customer_name:e.target.value}))} placeholder="예: 홍길동" /></label>
            <label>주문경로<select value={newOrder.order_source} onChange={e=>setNewOrder(p=>({...p,order_source:e.target.value}))}>{orderSources.map(c=><option key={c}>{c}</option>)}</select></label>
            <label>수납방식<select value={newOrder.payment_type} onChange={e=>setNewOrder(p=>({...p,payment_type:e.target.value, customer_payment_amount:e.target.value==='무료제공'?'':p.customer_payment_amount}))}><option>무료제공</option><option>선불</option><option>후불</option></select></label>
            <label>수납 예정 금액<input type="number" disabled={newOrder.payment_type==='무료제공'} value={newOrder.customer_payment_amount} onChange={e=>setNewOrder(p=>({...p,customer_payment_amount:e.target.value}))} placeholder="무료제공이면 공란" /></label>
          </div>
          <div className="accessoryItemsBox">
            <div className="accessoryItemsHead"><h4>주문 품목</h4><button type="button" onClick={addItem}>품목 추가</button></div>
            {newOrder.items.map((item,idx)=>(
              <div className="accessoryItemRow v287" key={idx}>
                <input aria-label={`${idx + 1}번 품목 모델명`} value={item.model_name} onChange={e=>updateItem(idx,{model_name:e.target.value})} placeholder="모델명 예) 아이폰 17 프로맥스" />
                <select aria-label={`${idx + 1}번 품목 카테고리`} value={item.category} onChange={e=>updateItem(idx,{category:e.target.value})}>{categories.map(c=><option key={c}>{c}</option>)}</select>
                <input aria-label={`${idx + 1}번 품목명`} value={item.item_name} onChange={e=>updateItem(idx,{item_name:e.target.value})} placeholder="예) 투명 케이스 / 다이어리 케이스(레드)" />
                <input aria-label={`${idx + 1}번 품목 원가`} type="number" value={item.price} onChange={e=>updateItem(idx,{price:e.target.value})} placeholder="원가" />
                <button aria-label={`${idx + 1}번 품목 삭제`} type="button" className="tinyDeleteBtn" onClick={()=>removeItem(idx)} disabled={newOrder.items.length<=1}>삭제</button>
              </div>
            ))}
            <div className="accessoryOrderTotal"><span>주문 원가 합계</span><strong>{formatKRW(orderTotal)}</strong><span>고객 수납 예정</span><strong>{newOrder.payment_type === '무료제공' ? '무료제공' : `${newOrder.payment_type} · ${formatKRW(paymentAmount)}`}</strong></div>
          </div>
          <div className="accessoryFormActions"><button className="primary accessorySubmitBtn" disabled={busy}>{editingId ? '수정 저장' : '주문건 생성'}</button>{editingId && <button type="button" onClick={()=>{setEditingId(null); setNewOrder({customer_name:'',order_source:'개통',payment_type:'무료제공',customer_payment_amount:'',items:[emptyItem()]});}}>취소</button>}</div>
        </form>
      </div>
      <div className="sectionCard accessoryListCard">
        <div className="accessoryMainTabs">{availableScopes().map(s=><button key={s.key} className={scope===s.key?'active':''} onClick={()=>setScope(s.key)}>{s.label}</button>)}</div>
        <div className="accessoryTabs v287">
          <button className={active==='pending'?'active':''} onClick={()=>setActive('pending')}>주문 미완료 <b>{counts.pending}</b></button>
          <button className={active==='completed'?'active':''} onClick={()=>setActive('completed')}>주문 완료 <b>{counts.completed}</b></button>
          <button className={active==='arrived'?'active':''} onClick={()=>setActive('arrived')}>매장 도착 <b>{counts.arrived}</b></button>
          <button className={active==='received'?'active':''} onClick={()=>setActive('received')}>고객 수령 <b>{counts.received}</b></button>
          <button className={active==='returned'?'active':''} onClick={()=>setActive('returned')}>반품 <b>{counts.returned}</b></button>
        </div>
        <div className="accessoryFilters">
          <input aria-label="악세사리 주문 검색" value={search} onChange={e=>setSearch(e.target.value)} placeholder="주문번호/고객명/모델명/품목 검색" />
          {scope==='all' && <select aria-label="매장 필터" value={storeFilter} onChange={e=>setStoreFilter(e.target.value)}><option value="">전체 매장</option>{storeOptions.map(s=><option key={s}>{s}</option>)}</select>}
          {scope !== 'mine' && <select aria-label="담당자 필터" value={employeeFilter} onChange={e=>setEmployeeFilter(e.target.value)}><option value="">전체 담당자</option>{employeeOptions.map(n=><option key={n}>{n}</option>)}</select>}
          {scope !== 'mine' && <select aria-label="카테고리 필터" value={categoryFilter} onChange={e=>setCategoryFilter(e.target.value)}><option value="">전체 카테고리</option>{categories.map(c=><option key={c}>{c}</option>)}</select>}
          {scope !== 'mine' && <select aria-label="주문 경로 필터" value={sourceFilter} onChange={e=>setSourceFilter(e.target.value)}><option value="">전체 경로</option>{orderSources.map(c=><option key={c}>{c}</option>)}</select>}
        </div>
        <div className="accessoryOrderList">
          {filtered.map(row=>{
            const items = normalizeAccessoryItems(row); const od = overdueDays(row.expected_arrival_date); const longUnclaimed = row.store_arrived && !row.customer_received && !row.is_returned ? od : 0;
            return <div className="accessoryOrderCard compact" key={row.id}>
              <div className="accessoryOrderTop"><div><strong>{row.order_code}</strong><p>{row.customer_name_masked} · {items[0]?.model_name || row.model_name}</p></div><span className={`accessoryBadge ${accessoryStatusKey(row)}`}>{accessoryOrderStatus(row)}</span></div>
              {(od > 0 && row.order_completed && !row.store_arrived && !row.is_returned) && <div className="accessoryWarning">예정일 초과 {od}일</div>}
              {longUnclaimed >= 3 && <div className="accessoryWarning">장기 미수령 {longUnclaimed}일</div>}
              <div className="accessoryItemsView compact">{items.map((item,idx)=><p key={idx}><b>{idx+1}. {item.category}</b><span>{item.model_name ? `${item.model_name} · ` : ''}{item.item_name} · {formatKRW(item.price)}</span></p>)}</div>
              <div className="accessoryMeta compact"><p><b>원가</b>{formatKRW(row.price)}</p><p><b>수납</b>{row.customer_payment_amount === null || row.customer_payment_amount === undefined ? '무료제공' : `${row.payment_type || '후불'} · ${formatKRW(row.customer_payment_amount)}`}</p><p><b>수익</b>{formatKRW(Number(row.customer_payment_amount||0)-Number(row.price||0))}</p><p><b>담당</b>{row.store_name} · {row.employee_name}</p><p><b>예정</b>{row.expected_arrival_date || '-'}</p></div>
              <div className="accessoryActions compact">{!row.is_returned && <button disabled={busy} onClick={()=>handleStatusChange(row)}>상태변경</button>}<button disabled={busy} onClick={()=>beginEdit(row)}>수정</button><button disabled={busy} onClick={()=>showHistory(row)}>이력</button>{(row.employee_name === user.name || isAdmin) && <button disabled={busy} onClick={()=>deleteOrder(row)}>삭제</button>}</div>
            </div>
          })}
          {!filtered.length && <p className="emptyAccessory">표시할 주문건이 없습니다.</p>}
        </div>
      </div>

      {statusModal && <div className="modalBg">
        <div className="modal accessoryStatusModal">
          <div className="modalHead">
            <h2>주문 상태 변경</h2>
            <button type="button" onClick={closeStatusModal}>닫기</button>
          </div>
          <div className="accessoryStatusSummary">
            <strong>{statusModal.order_code}</strong>
            <p>{statusModal.customer_name_masked} · {normalizeAccessoryItems(statusModal)[0]?.model_name || statusModal.model_name || '-'}</p>
            <span className={`accessoryBadge ${accessoryStatusKey(statusModal)}`}>현재 {accessoryOrderStatus(statusModal)}</span>
          </div>
          <label className="statusModalLabel">변경할 상태
            <select value={statusDraft.next} onChange={e=>setStatusDraft(p=>({...p,next:e.target.value}))}>
              {statusOptionsFor(statusModal).map(opt=><option key={opt}>{opt}</option>)}
            </select>
          </label>

          {statusDraft.next === '주문 완료' && <label className="statusModalLabel">도착 예정일
            <input type="date" value={statusDraft.expected_arrival_date} onChange={e=>setStatusDraft(p=>({...p,expected_arrival_date:e.target.value}))} />
          </label>}

          {statusDraft.next === '반품' && <div className="statusModalReturnBox">
            <label className="statusModalLabel">반품 사유
              <select value={statusDraft.return_reason} onChange={e=>setStatusDraft(p=>({...p,return_reason:e.target.value}))}>
                {returnReasons.map(r=><option key={r}>{r}</option>)}
              </select>
            </label>
            {statusDraft.return_reason === '기타' && <textarea value={statusDraft.return_reason_extra} onChange={e=>setStatusDraft(p=>({...p,return_reason_extra:e.target.value}))} placeholder="반품 사유를 입력해주세요." />}
          </div>}

          <div className="modalActionRow">
            <button type="button" onClick={closeStatusModal}>취소</button>
            <button type="button" className="primary" disabled={busy} onClick={submitStatusModal}>변경 저장</button>
          </div>
        </div>
      </div>}
    </div>
  );
}
function HomeDashboard({ user, setTab }) {
  const [happyCount,setHappyCount]=useState(0);
  const [reviewCount,setReviewCount]=useState(0);
  const [freepassMine,setFreepassMine]=useState(0);
  const [managerPending,setManagerPending]=useState(0);
  const [finalPending,setFinalPending]=useState(0);
  const [suggestions,setSuggestions]=useState(0);
  const [errors,setErrors]=useState(0);

  useEffect(()=>{ load(); },[]);

  async function load(){
    try{
      const today = todayLocalISO ? todayLocalISO() : new Date().toISOString().slice(0,10);

      const [{data:mine,error:mineError},{data:mineLogs,error:mineLogsError}] = await Promise.all([
        supabase.from('happycall_targets').select('id,assigned_employee,target_date,scheduled_date,assigned_store,is_skipped').eq('assigned_employee',user.name),
        supabase.from('happycall_logs').select('target_id,employee_name').eq('employee_name',user.name)
      ]);
      if (mineError) throw mineError;
      if (mineLogsError) throw mineLogsError;
      const completedTargetIds = new Set((mineLogs||[]).map(log=>log.target_id));
      setHappyCount((mine||[])
        .filter(isVisibleHappycallTarget)
        .filter(target => !completedTargetIds.has(target.id) && !isFutureScheduledTarget(target))
        .length);

      if(isAdminLike(user)){
        const {data:reviewLogs,error:reviewLogsError}=await supabase
          .from('happycall_logs')
          .select('id,target_id,review_status,checked_at')
          .in('review_status',['검수대기','반려','대기']);
        if (reviewLogsError) throw reviewLogsError;

        const latestReviewByTarget = {};
        (reviewLogs||[]).forEach(log => {
          const previous = latestReviewByTarget[log.target_id];
          if (!previous || String(log.checked_at||'').localeCompare(String(previous.checked_at||'')) > 0) {
            latestReviewByTarget[log.target_id] = log;
          }
        });
        const reviewTargetIds = Object.keys(latestReviewByTarget);
        if (!reviewTargetIds.length) {
          setReviewCount(0);
        } else {
          const reviewTargets = await fetchRowsByIds(
            'happycall_targets',
            reviewTargetIds,
            'id,assigned_store,is_skipped'
          );
          setReviewCount((reviewTargets||[]).filter(isVisibleHappycallTarget).length);
        }
      }

      const {data:fp}=await supabase.from('freepass_requests').select('id,status,employee_name,employee_store').eq('employee_name',user.name);
      setFreepassMine((fp||[]).filter(r => ['점장승인대기','최종승인대기','임시저장'].includes(r.status)).length);

      if(user.role==='점장' || isAdminLike(user)){
        const {data:mp}=await supabase.from('freepass_requests').select('id,status,employee_store').eq('status','점장승인대기');
        setManagerPending(isAdminLike(user) ? (mp||[]).length : (mp||[]).filter(r=>r.employee_store===user.store_name).length);
      }

      if(isSuperAdmin(user)){
        const {data:fp2}=await supabase.from('freepass_requests').select('id,status').eq('status','최종승인대기');
        setFinalPending((fp2||[]).length);
      }

      const {data:sg}=await supabase.from('suggestions').select('id,status,requester_name');
      const visibleSuggestions = isAdminLike(user) ? (sg||[]) : (sg||[]).filter(r => r.requester_name === user.name);
      setSuggestions(visibleSuggestions.filter(r=>!['완료','종료'].includes(r.status)).length);

      if(isAdminLike(user)){
        const {data:er}=await supabase.from('error_reports').select('id,status');
        setErrors((er||[]).filter(r=>!['완료','해결','해결완료','보류'].includes(r.status)).length);
      }
    }catch(e){
      console.warn('dashboard load failed', e);
    }
  }

  const cards = [
    {title:'내 해피콜', value:happyCount, desc:'진행 필요', tab:'mycalls', show:!isSuperAdmin(user)},
    {title:'해피콜 검수', value:reviewCount, desc:'확인 필요', tab:'review', show:isAdminLike(user)},
    {title:'내 프리패스', value:freepassMine, desc:'진행 중 신청', tab:'freepass', show:true},
    {title:'악세사리 주문', value:0, desc:'주문 관리', tab:'accessories', show:true},
    {title:'점장 승인', value:managerPending, desc:'승인 대기', tab:'freepass', freepassTab:'점장 승인', show:user.role==='점장'||isAdminLike(user)},
    {title:'최종 승인', value:finalPending, desc:'최고관리자 확인', tab:'freepass', freepassTab:'최종 승인', show:isSuperAdmin(user)},
    {title:'건의/문의', value:suggestions, desc:'진행 중', tab:'suggestions', show:true},
    {title:'오류보고', value:errors, desc:'미해결', tab:'errors', show:isAdminLike(user)},
  ].filter(c=>c.show);

  return (
    <div className="homeDashboard">
      <div className="homeHero">
        <div>
          <p className="eyebrow">세찬컴퍼니 인트라넷</p>
          <h2>{user.name}님, 오늘 확인할 업무입니다.</h2>
          <p className="muted">업무·인사·소통 현황을 한 화면에서 확인하세요.</p>
        </div>
      </div>

      <div className="dashboardGrid">
        {cards.map(c=>(
          <button key={c.title} className="dashboardCard" onClick={()=>{
            if (c.freepassTab) {
              try { localStorage.setItem('sechan_freepass_initial_tab', c.freepassTab); } catch {}
            }
            setTab(c.tab);
          }}>
            <span>{c.title}</span>
            <strong>{c.value}</strong>
            <em>{c.desc}</em>
          </button>
        ))}
      </div>

    </div>
  );
}



function MobileSideDrawer({ open, onClose, user, setTab, onLogout, onPassword }) {
  if (!open) return null;
  const isAdmin = isAdminLike(user);
  const isManager = user.role === '점장';
  const isChecker = user.role === '검수자' || isAdminLike(user);
  const go = (nextTab) => { setTab(nextTab); onClose(); };

  return (
    <div className="mobileDrawerOverlay" onClick={onClose}>
      <aside className="mobileDrawer" onClick={e=>e.stopPropagation()}>
        <div className="drawerHead">
          <div>
            <strong>세찬컴퍼니</strong>
            <p>{user.name} · {user.store_name} · {user.role || '직원'} <span className="appVersionLabel">{APP_BUILD_VERSION}</span></p>
          </div>
          <button className="drawerClose" onClick={onClose}>닫기</button>
        </div>

        <div className="drawerGroup">
          <h4>메인</h4>
          <button onClick={()=>go('home')}>홈</button>
          {!isSuperAdmin(user) && <button onClick={()=>go('mycalls')}>내 해피콜</button>}
          <button onClick={()=>go('freepass')}>프리패스</button>
          <button onClick={()=>go('accessories')}>악세사리 주문</button>
          <button onClick={()=>go('suggestions')}>건의/문의</button>
        </div>

        {(isManager || isChecker || isAdmin) && <div className="drawerGroup">
          <h4>해피콜</h4>
          {isManager && <button onClick={()=>go('manager')}>매장 현황</button>}
          {isManager && <button onClick={()=>go('storecalls')}>매장 리스트</button>}
          {(isAdmin || isChecker) && <button onClick={()=>go('review')}>검수</button>}
          {(isAdmin || isChecker) && <button onClick={()=>go('allcalls')}>전체 해피콜</button>}
          {isAdmin && <button onClick={()=>go('assignmentStatus')}>배정 현황</button>}
          {(isAdmin || isChecker) && <button onClick={()=>go('performance')}>전체 직원 현황</button>}
          {isAdmin && <button onClick={()=>go('refused')}>통화 불가 고객</button>}
          {isAdmin && <button onClick={()=>go('rawupload')}>RAW 업로드</button>}
          {isAdmin && <button onClick={()=>go('targetgen')}>해피콜 생성</button>}
        </div>}

        {isAdmin && <div className="drawerGroup">
          <h4>관리</h4>
          <button onClick={()=>go('employees')}>직원관리</button>
          <button onClick={()=>go('stores')}>매장관리</button>
          <button onClick={()=>go('audit')}>감사로그</button>
          <button onClick={()=>go('errors')}>오류보고</button>
        </div>}

        <div className="drawerGroup">
          <h4>설정</h4>
          <button onClick={()=>go('pushSettings')}>알림 설정</button>
          <button onClick={()=>go('guide')}>사용방법</button>
          <button onClick={onPassword}>비밀번호 변경</button>
          <button className="dangerMenu" onClick={onLogout}>로그아웃</button>
        </div>
      </aside>
    </div>
  );
}

function MobileBottomNav({ tab, setTab, user }) { return null; }

function MainApp({ user, onLogout, onUserUpdate }) {
  const [tab, setTab] = useState('home');
  const [showPassword, setShowPassword] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [openMenu, setOpenMenu] = useState('');
  const isAdmin = isAdminLike(user);
  const isManager = user.role === '점장';
  const isChecker = user.role === '검수자' || isAdminLike(user);

  return (
    <div className="app">
      <AutoLogoutGuard onLogout={onLogout} />
      <UpdateNotice user={user} currentTab={tab} />
      <header>
        <div>
          <h1>세찬컴퍼니 인트라넷</h1>
          <p>{user.name} · {user.store_name} · {user.role || '직원'} <span className="appVersionLabel">{APP_BUILD_VERSION}</span></p>
        </div>
        <div className="headerRight"><img className="headerLogo" src="./sechan-logo.png" alt="세찬컴퍼니 로고" onError={e=>{e.currentTarget.style.display='none'}} /><div className="headerActions desktopHeaderActions"><button onClick={() => setShowPassword(true)} className="compactHeaderButton">비밀번호 변경</button><button onClick={onLogout} className="compactHeaderButton">로그아웃</button></div><button className="mobileHamburgerBtn" onClick={()=>setMobileDrawerOpen(true)} aria-label="메뉴 열기">☰</button></div>
      </header>
      <MobileSideDrawer open={mobileDrawerOpen} onClose={()=>setMobileDrawerOpen(false)} user={user} setTab={setTab} onLogout={onLogout} onPassword={()=>{setMobileDrawerOpen(false); setShowPassword(true);}} />

      <div className="navHoverShell" onMouseLeave={()=>setOpenMenu('')}>
      <nav className="topNav compactNav">
        <button className={tab==='home'?'active':''} onClick={()=>setTab('home')}>홈</button>
        <div className="compactGroup desktopMegaTrigger" onMouseEnter={()=>setOpenMenu('happycall')}>
          <button type="button" className={`compactHead ${openMenu === 'happycall' ? 'active' : ''}`} onClick={e=>e.preventDefault()}>
            해피콜
          </button>
        </div>

        <button className={tab==='freepass'?'active':''} onClick={()=>setTab('freepass')}>프리패스</button>
              <button className={tab==='accessories'?'active':''} onClick={()=>setTab('accessories')}>악세사리 주문</button>

        <button className={tab==='pushSettings'?'active':''} onClick={()=>setTab('pushSettings')}>알림 설정</button>

        {isAdmin && (
          <div className="compactGroup desktopMegaTrigger" onMouseEnter={()=>setOpenMenu('settings')}>
            <button type="button" className={`compactHead ${openMenu === 'settings' ? 'active' : ''}`} onClick={e=>e.preventDefault()}>
              기본 설정
            </button>
          </div>
        )}

        <button className={tab==='suggestions'?'active':''} onClick={()=>setTab('suggestions')}>건의/문의</button>
        <button className={tab==='guide'?'active':''} onClick={()=>setTab('guide')}>사용방법</button>
      </nav>
      {(openMenu === 'happycall' || openMenu === 'settings') && (
        <div className="navMegaPanel">
          {openMenu === 'happycall' && (
            <div className="navMegaInner">
              <div className="navMegaColumn">
                <h4>해피콜</h4>
                {!isSuperAdmin(user) && <button className={tab==='mycalls'?'active':''} onClick={()=>setTab('mycalls')}>내 해피콜</button>}
                {isManager && <button className={tab==='manager'?'active':''} onClick={()=>setTab('manager')}>매장 현황</button>}
                {isManager && <button className={tab==='storecalls'?'active':''} onClick={()=>setTab('storecalls')}>매장 리스트</button>}
                {isManager && <button className={tab==='storePerformance'?'active':''} onClick={()=>setTab('storePerformance')}>직원별 현황</button>}
              </div>
              {(isAdmin || isChecker) && (
                <div className="navMegaColumn">
                  <h4>검수/현황</h4>
                  <button className={tab==='review'?'active':''} onClick={()=>setTab('review')}>검수</button>
                  <button className={tab==='allcalls'?'active':''} onClick={()=>setTab('allcalls')}>전체 해피콜</button>
                  {isAdmin && <button className={tab==='assignmentStatus'?'active':''} onClick={()=>setTab('assignmentStatus')}>배정 현황</button>}
                  <button className={tab==='performance'?'active':''} onClick={()=>setTab('performance')}>전체 직원 현황</button>
                </div>
              )}
              {isAdmin && (
                <div className="navMegaColumn">
                  <h4>관리 작업</h4>
                  <button className={tab==='rawupload'?'active':''} onClick={()=>setTab('rawupload')}>RAW 업로드</button>
                  <button className={tab==='targetgen'?'active':''} onClick={()=>setTab('targetgen')}>해피콜 생성</button>
                  <button className={tab==='refused'?'active':''} onClick={()=>setTab('refused')}>통화 불가 고객</button>
                </div>
              )}
            </div>
          )}

          {openMenu === 'settings' && isAdmin && (
            <div className="navMegaInner small">
              <div className="navMegaColumn">
                <h4>기본 설정</h4>
                <button className={tab==='employees'?'active':''} onClick={()=>setTab('employees')}>직원관리</button>
                <button className={tab==='stores'?'active':''} onClick={()=>setTab('stores')}>매장관리</button>
              </div>
              <div className="navMegaColumn">
                <h4>기록/오류</h4>
                <button className={tab==='audit'?'active':''} onClick={()=>setTab('audit')}>감사로그</button>
                <button className={tab==='errors'?'active':''} onClick={()=>setTab('errors')}>오류보고</button>
              </div>
            </div>
          )}
        </div>
      )}
      </div>

      <main>
        {tab === 'dashboard' && <Dashboard user={user} />}
        {tab === 'mycalls' && !isSuperAdmin(user) && <CallList user={user} mode="mine" />}
        {tab === 'suggestions' && <SuggestionsPage user={user} />}
        {tab === 'home' && <HomeDashboard user={user} setTab={setTab} />}
        {tab === 'freepass' && <FreepassModule user={user} />}
        {tab === 'accessories' && <AccessoryOrdersPage user={user} />}
        {tab === 'pushSettings' && <PushSettings user={user} />}
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
        {tab === 'assignmentStatus' && isAdmin && <HappycallAssignmentStatus user={user} />}
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



function InlineLoadingState({ label = '로딩 중' }) {
  return <div className="inlineLoadingState"><span className="loadingDot" /><span className="inlineLoadingText">{label}</span></div>;
}

function EmptyStateText({ children }) {
  return <div className="freepassStateBox">{children}</div>;
}

function PaginationBar({ total, page, onPageChange, pageSize = 100 }) {
  const totalPages = Math.max(1, Math.ceil(Number(total || 0) / pageSize));
  if (totalPages <= 1) return null;
  return (
    <div className="paginationBar" aria-label="목록 페이지 이동">
      <button type="button" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>이전</button>
      <span>{page} / {totalPages} 페이지 · 총 {total}건</span>
      <button type="button" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>다음</button>
    </div>
  );
}

function MobileInfoCard({ title, subtitle, meta = [], status, badgeClass = '', onClick, children }) {
  const CardTag = onClick ? 'button' : 'div';
  return (
    <CardTag {...(onClick ? { type: 'button', onClick } : {})} className={`mobileInfoCard ${onClick ? 'interactive' : 'static'}`}>
      <div className="mobileInfoCardMain">
        <div>
          <strong>{title}</strong>
          {subtitle && <p>{subtitle}</p>}
          {meta.filter(Boolean).map((m, idx) => <span key={idx}>{m}</span>)}
        </div>
        {status && <em className={`requestStatusBadge ${badgeClass}`}>{status}</em>}
      </div>
      {children && <div className="mobileInfoCardExtra">{children}</div>}
    </CardTag>
  );
}

function useModalBodyScrollLock() {
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevTouchAction = document.body.style.touchAction;
    document.body.style.overflow = 'hidden';
    document.body.style.touchAction = 'none';
    return () => {
      document.body.style.overflow = prevOverflow;
      document.body.style.touchAction = prevTouchAction;
    };
  }, []);
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
  const isRejected = (t) => latestLogByTarget[t.id]?.review_status === '반려';
  const isCompleted = (t) => latestLogByTarget[t.id] && !isRejected(t);
  const scheduledTargets = targets.filter(t => !latestLogByTarget[t.id] && effectiveTargetDate(t) > today);
  const activeTargets = targets.filter(t => isCompleted(t) || isRejected(t) || effectiveTargetDate(t) <= today);
  const total = activeTargets.length;
  const done = activeTargets.filter(isCompleted).length;
  const rejected = activeTargets.filter(isRejected).length;
  const pending = activeTargets.filter(t => !latestLogByTarget[t.id] || isRejected(t)).length;
  const todayTargets = activeTargets.filter(t => effectiveTargetDate(t) === today);
  const todayDone = todayTargets.filter(isCompleted).length;
  const overdueTargets = activeTargets.filter(t => (!latestLogByTarget[t.id] || isRejected(t)) && diffDays(effectiveTargetDate(t), today) > 0);
  const voc = activeTargets.filter(t => latestLogByTarget[t.id]?.call_detail === '불만사항있음').length;
  const absent = activeTargets.filter(t => latestLogByTarget[t.id]?.call_result === '부재중').length;
  return { total, allTotal: targets.length, done, pending, rate: total ? Math.round(done/total*1000)/10 : 0,
    todayTotal: todayTargets.length, todayDone, todayPending: todayTargets.length - todayDone,
    todayRate: todayTargets.length ? Math.round(todayDone/todayTargets.length*1000)/10 : 0,
    overdue: overdueTargets.length, scheduled: scheduledTargets.length, voc, absent, rejected };
}

function effectiveTargetDate(target) {
  return target?.scheduled_date || target?.target_date || '';
}

function isFutureScheduledTarget(target, today = todayLocalISO()) {
  return Boolean(target?.scheduled_date && effectiveTargetDate(target) > today);
}

function sortTargetsByPriority(a, b, latestLogByTarget, today = todayLocalISO()) {
  const rank = (t) => {
    if (latestLogByTarget[t.id]) return 3;
    const d = diffDays(effectiveTargetDate(t), today);
    if (d > 0) return 0;
    if (d === 0) return 1;
    return 2;
  };
  const r = rank(a)-rank(b);
  if (r !== 0) return r;
  const da = diffDays(effectiveTargetDate(a), today);
  const db = diffDays(effectiveTargetDate(b), today);
  if (!latestLogByTarget[a.id] && !latestLogByTarget[b.id] && da !== db) return db-da;
  return String(effectiveTargetDate(b)).localeCompare(String(effectiveTargetDate(a)));
}
function StatusBadge({ target, log }) {
  if (log) return <span className="badge done">완료</span>;
  if (isFutureScheduledTarget(target)) return <span className="badge scheduled">처리 예정 · {effectiveTargetDate(target)}</span>;
  const overdueDays = diffDays(effectiveTargetDate(target));
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
      let allTargets;
      if (user?.role === '점장') {
        const { data } = await runNetworkRead(() => supabase
          .from('happycall_targets')
          .select(HAPPY_CALL_TARGET_LIST_COLUMNS)
          .eq('assigned_store', user.store_name)
          .order('target_date', { ascending: true }));
        allTargets = data || [];
      } else {
        allTargets = await fetchAllRows('happycall_targets', HAPPY_CALL_TARGET_LIST_COLUMNS, 'target_date');
      }
      let visible = (allTargets || []).filter(isVisibleHappycallTarget);
      if (user?.role === '점장') visible = visible.filter(t => t.assigned_store === user.store_name);
      const allLogs = user?.role === '점장'
        ? await fetchRowsByValues('happycall_logs', 'target_id', visible.map(t => t.id), HAPPY_CALL_LOG_LIST_COLUMNS)
        : await fetchAllRows('happycall_logs', HAPPY_CALL_LOG_LIST_COLUMNS, 'checked_at');
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

function Card({title, value, subValue, valueClass}) {
  return <div className="stat"><span>{title}</span><b>{value}{subValue && <span className="cardSubValue">{subValue}</span>}</b></div>;
}


function CallList({ user, mode, readOnly = false }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [customersByJoinNo, setCustomersByJoinNo] = useState({});
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('미완료전체');
  const [bulkTempOpen, setBulkTempOpen] = useState(false);
  const [storeFilter, setStoreFilter] = useState('전체');
  const [employeeFilter, setEmployeeFilter] = useState('전체');
  const [page, setPage] = useState(1);

  useEffect(() => { load(); }, [mode]);

  async function load() {
    setLoading(true);
    try {
      let allTargets;
      if (mode === 'mine') {
        const { data } = await runNetworkRead(() => supabase
          .from('happycall_targets')
          .select(HAPPY_CALL_TARGET_LIST_COLUMNS)
          .or(`temporary_assignee.eq.${user.name},assigned_employee.eq.${user.name}`)
          .order('target_date', { ascending: true }));
        allTargets = data || [];
      } else if (mode === 'store') {
        const { data } = await runNetworkRead(() => supabase
          .from('happycall_targets')
          .select(HAPPY_CALL_TARGET_LIST_COLUMNS)
          .eq('assigned_store', user.store_name)
          .order('target_date', { ascending: true }));
        allTargets = data || [];
      } else {
        allTargets = await fetchAllRows('happycall_targets', HAPPY_CALL_TARGET_LIST_COLUMNS, 'target_date');
      }
      let visible = (allTargets || []).filter(isVisibleHappycallTarget);
      if (mode === 'mine') {
        visible = visible.filter(t => {
          if (t.temporary_assignee) return t.temporary_assignee === user.name;
          return t.assigned_employee === user.name;
        });
      }
      if (mode === 'store') visible = visible.filter(t => t.assigned_store === user.store_name);
      const targetIds = visible.map(t => t.id);
      const joinNos = visible.map(t => t.join_no);
      const allLogs = mode === 'all'
        ? await fetchAllRows('happycall_logs', HAPPY_CALL_LOG_LIST_COLUMNS, 'checked_at')
        : await fetchRowsByValues('happycall_logs', 'target_id', targetIds, HAPPY_CALL_LOG_LIST_COLUMNS);
      const customers = mode === 'all'
        ? await fetchAllRows('customers', CUSTOMER_DISPLAY_COLUMNS, 'open_date')
        : await fetchRowsByValues('customers', 'join_no', joinNos, CUSTOMER_DISPLAY_COLUMNS, 250);
      setCustomersByJoinNo(Object.fromEntries((customers || []).map(c => [c.join_no, c])));
      setTargets(visible);
      setLogs(allLogs || []);
      setPage(1);
    } catch (e) {
      alert('해피콜 리스트 조회 오류: ' + e.message);
    } finally {
      setLoading(false);
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
    else if (filter === '경과미완료') list = list.filter(t => !latestLogByTarget[t.id] && diffDays(effectiveTargetDate(t)) > 0);
    else if (filter === '오늘신규') list = list.filter(t => effectiveTargetDate(t) === todayLocalISO());
    else if (filter === '처리예정') list = list.filter(t => !latestLogByTarget[t.id] && isFutureScheduledTarget(t));
    else if (filter === '미완료전체') list = list.filter(t => (!latestLogByTarget[t.id] || latestLogByTarget[t.id]?.review_status === '반려') && effectiveTargetDate(t) <= todayLocalISO());
    else if (filter === '완료') list = list.filter(t => latestLogByTarget[t.id] && latestLogByTarget[t.id]?.review_status !== '반려');
    return list.sort((a,b)=>sortTargetsByPriority(a,b,latestLogByTarget));
  }, [targets, latestLogByTarget, filter, mode, storeFilter, employeeFilter]);

  useEffect(() => { setPage(1); }, [filter, storeFilter, employeeFilter, mode]);
  const pageSize = 100;
  const pageTargets = filteredTargets.slice((page - 1) * pageSize, page * pageSize);

  const title = mode === 'mine' ? '내 해피콜 리스트' : mode === 'store' ? `${user.store_name} 해피콜 진행현황` : '전체 해피콜 리스트';

  return (
    <div>
      <h2>{title}</h2>
      {loading ? (
        <div className="sectionCard pageLoadingPanel"><InlineLoadingState /></div>
      ) : (<>
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
        <button className={filter==='처리예정'?'active scheduledFilter':''} onClick={()=>setFilter('처리예정')}>처리 예정 {stats.scheduled}</button>
        <button className={filter==='완료'?'active':''} onClick={()=>setFilter('완료')}>완료 {stats.done}</button>
        <button className={filter==='전체'?'active':''} onClick={()=>setFilter('전체')}>전체 {stats.allTotal}</button>
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
        {pageTargets.map(t => {
          const log = latestLogByTarget[t.id];
          return (
            <div className="callItem" key={t.id} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })}>
              <div>
                <b>{formatCustomerJoinNo(t.join_no, customersByJoinNo, t.customer_name)}</b>
                <p>{t.assigned_store} · {t.temporary_assignee ? `${t.assigned_employee} → 임시 ${t.temporary_assignee}` : t.assigned_employee} · {callTypeLabel(t.call_type)}</p>
                <p className="muted">{t.scheduled_date ? `원 대상일 ${t.original_target_date || t.target_date} · 처리 예정일 ${t.scheduled_date}` : `대상일 ${t.target_date}`} / {currentHappycallTerm(t.skip_reason || t.assign_reason)}</p>
                {log?.review_status === '반려' && <p className="rejectReason">반려사유: {log.review_memo || '반려 사유 없음'}</p>}
              </div>
              {log?.review_status === '반려' ? <span className="badge rejected">반려</span> : <StatusBadge target={t} log={log} />}
            </div>
          );
        })}
      </div>
      <PaginationBar total={filteredTargets.length} page={page} onPageChange={setPage} pageSize={pageSize} />
      {selected && <CallModal target={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} readOnly={readOnly} />}
      {bulkTempOpen && <BulkTempAssignModal user={user} targets={targets} latestLogByTarget={latestLogByTarget} onClose={()=>setBulkTempOpen(false)} onSaved={load} />}
      </>)}
    </div>
  );
}

function callTypeLabel(type) {
  return ({
    MONTHLY_DAY: '월간 정기',
    D_PLUS_1: 'D+1',
    D_PLUS_7: 'D+7',
    D_PLUS_13: 'D+13',
    D_PLUS_93: 'D+93',
    D_PLUS_183: 'D+183',
    D_PLUS_95: 'D+95',
    D_PLUS_185: 'D+185'
  })[type] || type;
}

function currentHappycallTerm(value) {
  return String(value || '')
    .replaceAll('D+95', 'D+93')
    .replaceAll('D+185', 'D+183');
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
          temporary_assign_reason: 'D+93/D+183 일괄 임시 배정'
        }).eq('id', id);
        if (error) throw error;
      }
      await writeAuditLog('임시처리자일괄변경', 'happycall_targets', user.store_name, user, `D+93/D+183 ${selectedIds.length}건 → ${assignee}`);
      alert(`임시 배정 완료: ${selectedIds.length}건`);
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '내 해피콜', actionName: 'D+93/D+183 일괄 임시 배정', error: e });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modalBg">
      <div className="modal bulkTempModal">
        <div className="modalHead"><h2>D+93 / D+183 임시 배정</h2><button onClick={onClose}>닫기</button></div>
        <section>
          <div className="bulkTempToolbar">
            <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)}><option>전체</option><option>D+93</option><option>D+183</option></select>
            <select value={stateFilter} onChange={e=>setStateFilter(e.target.value)}><option>전체</option><option>미완료</option><option>반려</option></select>
            <select value={assignee} onChange={e=>setAssignee(e.target.value)}><option value="">임시 처리자 선택</option>{staffOptions.map(e => <option key={e.id || e.name} value={e.name}>{e.name}</option>)}</select>
            <button onClick={()=>setSelectedIds(list.map(t => t.id))}>전체 선택</button>
            <button onClick={()=>setSelectedIds([])}>선택 해제</button>
            <button className="primary" disabled={busy} onClick={saveBulk}>임시 배정 저장</button>
          </div>
          <p className="muted">내 매장의 D+93/D+183 중 미완료 또는 반려 건만 표시됩니다. 대상일이 지난 미완료 건도 포함됩니다.</p>
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
                  <td>{t.join_no}</td><td>{callTypeLabel(t.call_type)}</td><td>{effectiveTargetDate(t)}</td><td>{t.assigned_employee}</td><td>{t.temporary_assignee || '-'}</td><td>{isFutureScheduledTarget(t) ? '처리 예정' : log?.review_status === '반려' ? '반려' : '미완료'}</td>
                </tr>;
              })}
              {!list.length && <tr><td colSpan="7" className="muted">임시 배정 가능한 D+93/D+183 건이 없습니다.</td></tr>}
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
  useModalBodyScrollLock();
  const [joinNoReason, setJoinNoReason] = useState('');

  const rejectedInfo = useMemo(() => {
    return history.find(h => h.review_status === '반려');
  }, [history]);
  const [script, setScript] = useState(null);
  const [employees, setEmployees] = useState([]);
  const [tempAssignee, setTempAssignee] = useState(target.temporary_assignee || '');
  const [tempBusy, setTempBusy] = useState(false);
  const [scheduledDate, setScheduledDate] = useState(target.scheduled_date || target.target_date || todayLocalISO());
  const [scheduleReason, setScheduleReason] = useState(target.scheduled_change_reason || '');
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const scheduleBusyRef = useRef(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const saveBusyRef = useRef(false);
  const saveOperationIdRef = useRef(null);
  const vocOperationIdRef = useRef(null);
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
    const legacyScriptType = target.call_type === 'D_PLUS_93' ? 'D_PLUS_95' : target.call_type === 'D_PLUS_183' ? 'D_PLUS_185' : target.call_type;
    const { data: s } = await supabase.from('call_scripts').select('*').eq('call_type', legacyScriptType).maybeSingle();
    setScript(s ? {
      ...s,
      title: target.call_type === 'D_PLUS_93'
        ? String(s.title || '').replace('D+95', 'D+93')
        : target.call_type === 'D_PLUS_183'
          ? String(s.title || '').replace('D+185', 'D+183')
          : s.title
    } : null);
    const { data: e } = await supabase.from('employees').select('*').eq('status', '재직').order('name');
    setEmployees(e || []);
  }

  function onResultChange(v) {
    setResult(v);
    setDetail('');
    // 결과 변경 시 미성년자 정보 유지;
  }

  
  const canTempAssign = (user.role === '관리자' || user.role === '점장') && isD95D185Type(target.call_type);
  const activeAssignee = target.temporary_assignee || target.assigned_employee;
  const canReschedule = !latestLog && !readOnly && isD95D185Type(target.call_type) && activeAssignee === user.name;

  async function saveScheduledDate(reset = false) {
    if (scheduleBusyRef.current) return;
    if (!canReschedule) return alert('본인에게 배정된 D+93 / D+183 미완료 건만 처리 예정일을 변경할 수 있습니다.');
    const baseDate = target.original_target_date || target.target_date;
    const nextDate = reset ? null : scheduledDate;
    if (!reset && !nextDate) return alert('처리 예정일을 선택해주세요.');
    if (!reset && nextDate < todayLocalISO()) return alert('오늘 이전 날짜로는 변경할 수 없습니다.');
    if (!reset && !scheduleReason.trim()) return alert('처리 예정일 변경 사유를 입력해주세요.');
    if (!confirm(reset ? `처리 예정일을 원 대상일 ${baseDate}로 되돌릴까요?` : `실제 처리 예정일을 ${nextDate}로 변경할까요?`)) return;

    scheduleBusyRef.current = true;
    setScheduleBusy(true);
    try {
      const payload = reset ? {
        scheduled_date: null,
        scheduled_changed_by: user.name,
        scheduled_changed_at: new Date().toISOString(),
        scheduled_change_reason: '원 대상일로 복원'
      } : {
        scheduled_date: nextDate,
        scheduled_changed_by: user.name,
        scheduled_changed_at: new Date().toISOString(),
        scheduled_change_reason: scheduleReason.trim()
      };
      await runNetworkMutation(() => supabase.from('happycall_targets').update(payload).eq('id', target.id));
      await writeAuditLog('해피콜처리예정일변경', 'happycall_targets', target.id, user, `${callTypeLabel(target.call_type)} / ${baseDate} → ${nextDate || baseDate} / ${payload.scheduled_change_reason}`);
      alert(reset ? '원 대상일로 되돌렸습니다.' : '처리 예정일이 변경되었습니다. 지정일 전에는 미완료로 집계되지 않습니다.');
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '해피콜 상세', actionName: '처리 예정일 변경', joinNo: target.join_no, error: e });
    } finally {
      scheduleBusyRef.current = false;
      setScheduleBusy(false);
    }
  }

  const tempAssigneeOptions = useMemo(() => {
    return (employees || [])
      .filter(e => e.store_name === target.assigned_store && e.name !== user.name)
      .sort((a,b)=>String(a.name).localeCompare(String(b.name), 'ko'));
  }, [employees, target.assigned_store, user.name]);

  async function saveTempAssignee() {
    if (!canTempAssign) return alert('D+93 / D+183 건만 임시 처리자 변경이 가능합니다.');
    if (!tempAssignee) return alert('임시 처리자를 선택해주세요.');
    if (!confirm(`${target.join_no} 건을 이번 1회만 ${tempAssignee}에게 임시 배정할까요?`)) return;

    setTempBusy(true);
    try {
      const { error } = await supabase.from('happycall_targets').update({
        temporary_assignee: tempAssignee,
        temporary_assignee_store: target.assigned_store,
        temporary_assigned_by: user.name,
        temporary_assigned_at: new Date().toISOString(),
        temporary_assign_reason: 'D+93/D+183 임시 처리자 변경'
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

    if (saveBusyRef.current) return;
    saveBusyRef.current = true;
    setSaveBusy(true);

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

      const existingPending = latestLog && (latestLog.review_status || '검수대기') === '검수대기' ? latestLog : null;
      if (existingPending) {
        await runNetworkMutation(() => supabase.from('happycall_logs').update({
          ...payload,
          checked_at: new Date().toISOString()
        }).eq('id', existingPending.id));
      } else {
        if (!saveOperationIdRef.current) saveOperationIdRef.current = createClientUuid();
        await runNetworkMutation(() => supabase.from('happycall_logs').upsert({
          id: saveOperationIdRef.current,
          ...payload,
          parent_log_id: latestLog?.review_status === '반려' ? latestLog.id : null,
          review_round: latestLog?.review_status === '반려' ? (Number(latestLog.review_round || 1) + 1) : 1
        }, { onConflict: 'id' }));
      }

      if (shouldExcludeUnavailable(result)) {
        await runNetworkMutation(() => supabase.from('refused_customers').upsert({
          join_no: target.join_no,
          target_id: target.id,
          refused_by: user.name,
          refused_at: new Date().toISOString(),
          memo: memo || detail || '통화 불가',
          legal_rep_join_no: null
        }, { onConflict: 'join_no' }));

        await runNetworkMutation(() => supabase.from('happycall_targets')
          .update({ is_skipped: true, skip_reason: `통화 불가 처리: ${detail}` })
          .eq('join_no', target.join_no)
          .neq('id', target.id)
          .is('is_skipped', false)
          .not('call_type', 'in', '(D_PLUS_93,D_PLUS_183,D_PLUS_95,D_PLUS_185)'));
      } else {
        await runNetworkMutation(() => supabase.from('refused_customers').delete().eq('join_no', target.join_no));
      }

      if (typeof rejectedInfo !== 'undefined' && rejectedInfo?.id) {
        await runNetworkMutation(() => supabase.from('happycall_logs').update({
          review_status: '재처리완료'
        }).eq('id', rejectedInfo.id));
      }

      if (detail === '불만사항있음') {
        if (!vocOperationIdRef.current) vocOperationIdRef.current = createClientUuid();
        await runNetworkMutation(() => supabase.from('voc_logs').upsert({
          id: vocOperationIdRef.current,
          target_id: target.id,
          join_no: target.join_no,
          customer_issue: memo,
          status: '미처리'
        }, { onConflict: 'id' }));
      }

      await writeAuditLog('해피콜저장', 'happycall_target', target.id, user, `${target.join_no} / ${result} / ${detail}`);
      saveOperationIdRef.current = null;
      vocOperationIdRef.current = null;
      alert('저장되었습니다. 검수 대기 상태로 등록되었습니다.');
      onSaved();
      onClose();
    } catch (e) {
      askErrorReport({ user, currentTab: '해피콜 상세', actionName: '해피콜 저장', joinNo: target.join_no, error: e });
    } finally {
      saveBusyRef.current = false;
      setSaveBusy(false);
    }
  }

  return (
    <div className="modalBg happycallModalBg" onTouchMove={(e)=>{ if(e.target === e.currentTarget) e.preventDefault(); }}>
      <div className="modal happycallDetailModal">
        <div className="modalHead"><h2>해피콜 상세</h2><div className="modalHeadBtns">{user.role === "관리자" && <button onClick={()=>setEditJoinNoOpen(!editJoinNoOpen)}>가입번호 수정</button>}<button onClick={onClose}>닫기</button></div></div>
        <div className="happycallDetailBody" style={{touchAction:'pan-y', WebkitOverflowScrolling:'touch', overflowY:'scroll'}}>
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
            <p><b>원 대상일</b><br />{target.original_target_date || target.target_date}</p>
            <p><b>실제 처리 예정일</b><br />{effectiveTargetDate(target)}</p>
            {hasMinorInfo(latestLog || target) && <p><b>미성년자</b><br />{isActiveMinor(latestLog?.minor_birth_date || target.minor_birth_date) ? '예' : '생일 경과/확인 필요'}</p>}
            {(latestLog?.minor_birth_date || target.minor_birth_date) && <p><b>미성년자 생년월일</b><br />{latestLog?.minor_birth_date || target.minor_birth_date}</p>}
            {(latestLog?.legal_rep_join_no || target.legal_rep_join_no) && <p><b>법정대리인 가입번호</b><br />{latestLog?.legal_rep_join_no || target.legal_rep_join_no}</p>}
            <p><b>유형</b><br />{callTypeLabel(target.call_type)}</p>
            <p><b>담당자</b><br />{target.assigned_employee}</p>
          </div>
        </section>
        <section><h3>배정 사유</h3><p className="reason">{currentHappycallTerm(target.assign_reason || target.skip_reason) || '배정 사유 없음'}</p></section>
        {canReschedule && (
          <section className="scheduleEditSection">
            <h3>D+93 / D+183 실제 처리 예정일</h3>
            <div className="scheduleEditBox">
              <label>처리 예정일<input type="date" min={todayLocalISO()} value={scheduledDate} onChange={e=>setScheduledDate(e.target.value)} /></label>
              <label>변경 사유<input value={scheduleReason} onChange={e=>setScheduleReason(e.target.value)} placeholder="예: 고객 요청으로 5일 뒤 처리" /></label>
              <button className="primary" disabled={scheduleBusy} onClick={()=>saveScheduledDate(false)}>{scheduleBusy ? '저장 중' : '처리 예정일 저장'}</button>
              {target.scheduled_date && <button disabled={scheduleBusy} onClick={()=>saveScheduledDate(true)}>원 대상일로 되돌리기</button>}
            </div>
            <p className="muted">지정일 전에는 미완료·완료율에 포함되지 않으며, 처리 예정 목록에는 계속 표시됩니다.</p>
          </section>
        )}
        {canTempAssign && (
          <section>
            <h3>D+93 / D+183 임시 처리자 변경</h3>
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
              <button className="primary" disabled={saveBusy} onClick={save}>{saveBusy ? '저장 중' : '저장'}</button>
            </>
          )}
        </section>
      </div>
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
  const [form, setForm] = useState({ name:'', store_name:'금촌', status:'재직', password:'', role:'직원', hire_date:'', resign_date:'', end_time:'20:00' });
  const [viewStatus, setViewStatus] = useState('재직');
  const [drafts, setDrafts] = useState({});
  const [detailTarget, setDetailTarget] = useState(null);
  const [reviewStoreTarget, setReviewStoreTarget] = useState(null);
  const [passwordTarget, setPasswordTarget] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    const [{ data: empData, error: empError }, { data: storeData, error: storeError }] = await Promise.all([
      supabase.from('employees').select('*').order('name'),
      supabase.from('stores').select('*').order('name')
    ]);

    if (empError) alert(empError.message);
    if (storeError) alert(storeError.message);

    const stores = sortStoresForEmployeeDropdown(storeData || []);
    setRows(empData || []);
    setStoreOptions(stores);

    const nextDrafts = {};
    (empData || []).forEach(r => {
      nextDrafts[r.id] = {
        store_name: normalizeOfficeStoreName(r.store_name || ''),
        status: r.status || '재직',
        role: r.role || '직원',
        password: r.password || '',
        happycall_assignment_enabled: r.happycall_assignment_enabled !== false
      };
    });
    setDrafts(nextDrafts);

    if (stores.length && !stores.some(s => s.name === form.store_name)) {
      setForm(prev => ({ ...prev, store_name: stores[0].name }));
    }
    setLoading(false);
  }

  function setDraft(id, patch) {
    setDrafts(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  }

  async function add() {
    if (!form.name.trim()) return alert('직원명을 입력해주세요.');
    if (!form.store_name) return alert('매장을 선택해주세요.');
    if (String(form.password || '').length < 4) return alert('초기 비밀번호를 4자리 이상 입력해주세요.');

    const payload = {
      name: form.name,
      store_name: form.store_name,
      status: form.status,
      password: form.password,
      role: form.role,
      happycall_assignment_enabled: true,
      hire_date: form.hire_date || null,
      resign_date: form.status === '퇴사' ? (form.resign_date || null) : null,
      end_time: normalizeWorkEndTime(form.end_time || '20:00')
    };

    const { error } = await supabase.from('employees').insert(payload);
    if (error) return alert(error.message);

    await writeAuditLog('직원추가', 'employee', form.name, user, `${form.name} / ${form.store_name} / ${form.role}`);
    setForm({ name:'', store_name: storeOptions[0]?.name || '금촌', status:'재직', password:'', role:'직원', hire_date:'', resign_date:'', end_time:'20:00' });
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

  async function saveAllEmployees() {
    const changed = rows.filter(employee => {
      const d = drafts[employee.id] || {};
      return (
        (d.store_name || '') !== (normalizeOfficeStoreName(employee.store_name || '')) ||
        (d.status || '재직') !== (employee.status || '재직') ||
        (d.role || '직원') !== (employee.role || '직원') ||
        (d.happycall_assignment_enabled !== false) !== (employee.happycall_assignment_enabled !== false)
      );
    });

    if (!changed.length) return alert('저장할 변경사항이 없습니다.');
    if (!confirm(`${changed.length}명의 직원 변경사항을 저장할까요?`)) return;

    try {
      for (const employee of changed) {
        const d = drafts[employee.id] || {};
        const patch = {
          store_name: d.store_name || employee.store_name || '',
          status: d.status || employee.status || '재직',
          role: d.role || employee.role || '직원',
          happycall_assignment_enabled: d.happycall_assignment_enabled !== false
        };
        if (patch.status === '퇴사' && !employee.resign_date) patch.resign_date = todayLocalISO();

        const { error } = await supabase.from('employees').update(patch).eq('id', employee.id);
        if (error) throw error;

        const detailParts = [formatAuditPatch(patch)];
        await writeAuditLog('직원일괄저장', 'employee', employee.id, user, `대상: ${employee.name} / ${detailParts.join(' / ')}`);
      }

      alert(`${changed.length}명의 직원 정보가 저장되었습니다.`);
      load();
    } catch (e) {
      alert('직원 일괄 저장 오류: ' + e.message);
    }
  }

  const storeSelect = (value, onChange) => (
    <select className="employeeStoreSelect" value={value || ''} onChange={e => onChange(e.target.value)}>
      <option value="">매장 선택</option>
      {storeOptions.map(s => (
        <option key={s.id || s.name} value={s.name}>
          {displayStoreNameForUi(s.name)}{s.status === '폐점' ? ' (폐점)' : ''}
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

      <div className="sectionCard employeeAddCard"><div className="employeeAddTitle"><h3>직원 추가</h3><p className="muted">신규 직원을 등록합니다.</p></div><div className="formGrid employeeAddGrid">
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
          <option>관리자</option><option>최고관리자</option>
        </select>
        <input type="password" autoComplete="new-password" aria-label="초기 비밀번호" placeholder="초기 비밀번호 4자리 이상" value={form.password} onChange={e=>setForm({...form,password:e.target.value})} />
        <input type="time" value={form.end_time} onChange={e=>setForm({...form,end_time:e.target.value})} title="프리패스 오후 사용 제한 기준 퇴근시간" />
        <button className="primary" onClick={add}>직원 추가</button>
      </div></div>

      <div className="employeeBulkSaveBar">
        <p className="muted">직원 정보 변경 후 상단의 전체 변경사항 저장 버튼을 눌러야 반영됩니다.</p>
        <button className="primary" onClick={saveAllEmployees}>전체 변경사항 저장</button>
      </div>

      <div className="sectionCard employeeTableWrap desktopEmployeeTableWrap">
        <table className="employeeTable compactEmployeeTable">
          <thead>
            <tr>
              <th>이름</th>
              <th>해피콜 배정</th>
              <th>매장</th>
              <th>상태</th>
              <th>권한</th>
              <th>비밀번호</th>
              <th>상세</th>
            </tr>
          </thead>
          <tbody>
            {filteredRows.map(r => {
              const d = drafts[r.id] || {};
              return (
                <tr key={r.id}>
                  <td className="employeeNameCell"><b>{r.name}</b></td>
                  <td>
                    <select className="happycallAssignSelect" value={(d.happycall_assignment_enabled ?? r.happycall_assignment_enabled) !== false ? '배정' : '미배정'} onChange={e=>setDraft(r.id,{happycall_assignment_enabled:e.target.value === '배정'})}>
                      <option>배정</option>
                      <option>미배정</option>
                    </select>
                  </td>
                  <td>{storeSelect(d.store_name ?? r.store_name, v => setDraft(r.id,{store_name:v}))}</td>
                  <td>
                    <select className="employeeStatusSelect" value={d.status ?? r.status ?? '재직'} onChange={e=>setDraft(r.id,{status:e.target.value})}>
                      <option>재직</option>
                      <option>퇴사</option>
                      <option>리스트 제외</option>
                    </select>
                  </td>
                  <td>
                    <select className="employeeRoleSelect" value={d.role ?? r.role ?? '직원'} onChange={e=>setDraft(r.id,{role:e.target.value})}>
                      <option>직원</option>
                      <option>점장</option>
                      <option>검수자</option>
                      <option>관리자</option><option>최고관리자</option>
                    </select>
                  </td>
                  <td><button className="passwordManageBtn" onClick={()=>setPasswordTarget(r)} disabled={r.status === '퇴사'}>관리</button></td>
                  <td><button className="employeeDetailBtn" onClick={()=>setDetailTarget(r)}>상세</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mobileCardList employeeMobileList">
        {loading && <InlineLoadingState />}
        {!loading && filteredRows.map(r => {
          const d = drafts[r.id] || {};
          const storeName = d.store_name ?? r.store_name ?? '-';
          const roleName = d.role ?? r.role ?? '직원';
          const statusName = d.status ?? r.status ?? '재직';
          const assignmentName = (d.happycall_assignment_enabled ?? r.happycall_assignment_enabled) !== false ? '해피콜 배정' : '해피콜 미배정';
          return (
            <MobileInfoCard
              key={r.id}
              title={r.name}
              subtitle={`${storeName} · ${roleName}`}
              meta={[`${statusName} · ${assignmentName}`]}
              status="상세"
              badgeClass="finalWaiting"
              onClick={() => setDetailTarget(r)}
            />
          );
        })}
        {!loading && !filteredRows.length && <EmptyStateText>표시할 직원이 없습니다.</EmptyStateText>}
      </div>

      <p className="muted">입사일, 퇴사일, 근무이력은 상세 버튼에서 관리합니다. 퇴사자는 로그인할 수 없습니다.</p>
      {storeOptions.length <= 1 && <p className="error">운영 매장 목록이 없습니다. 먼저 매장관리에서 매장을 등록해주세요.</p>}
      {detailTarget && <EmployeeDetailModal employee={detailTarget} stores={storeOptions} user={user} onClose={()=>setDetailTarget(null)} onUpdated={load} onOpenReviewStore={()=>{ setReviewStoreTarget(detailTarget); setDetailTarget(null); }} />}
      {reviewStoreTarget && <ReviewStorePermissionsModal employee={reviewStoreTarget} stores={storeOptions} user={user} onClose={()=>setReviewStoreTarget(null)} />}
      {passwordTarget && <EmployeePasswordManageModal employee={passwordTarget} user={user} onClose={()=>setPasswordTarget(null)} onUpdated={load} />}
    </div>
  );
}

function EmployeePasswordManageModal({ employee, user, onClose, onUpdated }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [resetPw, setResetPw] = useState('1234');
  const [busy, setBusy] = useState(false);
  useModalBodyScrollLock();

  async function changePassword() {
    if ((employee.password || '') !== current) return alert('기존 비밀번호가 맞지 않습니다.');
    if (!next || next.length < 4) return alert('희망 비밀번호는 4자리 이상 입력해주세요.');
    if (next !== confirmPw) return alert('희망 비밀번호 확인이 일치하지 않습니다.');
    if (!confirm(`${employee.name}님의 비밀번호를 변경할까요?`)) return;

    setBusy(true);
    const { error } = await supabase.from('employees').update({ password: next }).eq('id', employee.id);
    setBusy(false);
    if (error) return alert(error.message);

    await writeAuditLog('직원비밀번호변경', 'employee', employee.id, user, `대상: ${employee.name} / 비밀번호 변경`);
    alert('비밀번호가 변경되었습니다.');
    onUpdated?.();
    onClose();
  }

  async function resetPassword() {
    if (!resetPw || resetPw.length < 4) return alert('초기화 비밀번호는 4자리 이상 입력해주세요.');
    if (!confirm(`${employee.name}님의 비밀번호를 ${resetPw}로 초기화할까요?`)) return;

    setBusy(true);
    const { error } = await supabase.from('employees').update({ password: resetPw }).eq('id', employee.id);
    setBusy(false);
    if (error) return alert(error.message);

    await writeAuditLog('직원비밀번호초기화', 'employee', employee.id, user, `대상: ${employee.name} / 초기화 비밀번호: ${resetPw}`);
    alert('비밀번호가 초기화되었습니다.');
    onUpdated?.();
    onClose();
  }

  return (
    <div className="modalBg employeePasswordModalBg">
      <div className="modal employeePasswordModal">
        <div className="modalHead"><h2>{employee.name} 비밀번호 관리</h2><button onClick={onClose}>닫기</button></div>
        <div className="employeePasswordBody">
          <section>
            <h3>비밀번호 변경</h3>
            <p className="muted">기존 비밀번호를 확인한 뒤 희망 비밀번호로 변경합니다.</p>
            <label>기존 비밀번호</label>
            <input type="password" value={current} onChange={e=>setCurrent(e.target.value)} placeholder="기존 비밀번호" />
            <label>희망 비밀번호</label>
            <input type="password" value={next} onChange={e=>setNext(e.target.value)} placeholder="새 비밀번호" />
            <label>희망 비밀번호 확인</label>
            <input type="password" value={confirmPw} onChange={e=>setConfirmPw(e.target.value)} placeholder="새 비밀번호 재입력" onKeyDown={e=>{ if(e.key==='Enter') changePassword(); }} />
            <button className="primary" onClick={changePassword} disabled={busy}>비밀번호 변경</button>
          </section>

          <section>
            <h3>비밀번호 초기화</h3>
            <p className="muted">직원이 비밀번호를 모를 때 관리자가 지정한 값으로 초기화합니다.</p>
            <label>초기화 비밀번호</label>
            <input value={resetPw} onChange={e=>setResetPw(e.target.value)} placeholder="예: 1234" />
            <button className="blackButton" onClick={resetPassword} disabled={busy}>비밀번호 초기화</button>
          </section>
        </div>
      </div>
    </div>
  );
}


function EmployeeDetailModal({ employee, stores, user, onClose, onUpdated, onOpenReviewStore }) {
  const [profile, setProfile] = useState({
    hire_date: employee.hire_date || '',
    resign_date: employee.resign_date || '',
    end_time: employeeWorkEndTime(employee)
  });
  useModalBodyScrollLock();

  async function saveProfile() {
    const patch = {
      hire_date: profile.hire_date || null,
      resign_date: profile.resign_date || null,
      end_time: normalizeWorkEndTime(profile.end_time || '20:00')
    };

    const { error } = await supabase.from('employees').update(patch).eq('id', employee.id);
    if (error) return alert(error.message);

    await writeAuditLog('직원상세저장', 'employee', employee.id, user, `대상: ${employee.name} / 입사일: ${patch.hire_date || '-'} / 퇴사일: ${patch.resign_date || '-'} / 퇴근시간: ${patch.end_time || '20:00'}`);
    alert('상세 정보가 저장되었습니다.');
    onUpdated?.();
  }

  return (
    <div className="modalBg employeeDetailModalBg">
      <div className="modal employeeDetailModal">
        <div className="modalHead"><h2>{employee.name} 상세관리</h2><button onClick={onClose}>닫기</button></div>
        <div className="employeeDetailBody">

        <section>
          <h3>입사/퇴사 정보</h3>
          <div className="employeeProfileGrid">
            <label>입사일<input type="date" value={profile.hire_date} onChange={e=>setProfile({...profile,hire_date:e.target.value})} /></label>
            <label>퇴사일<input type="date" value={profile.resign_date} onChange={e=>setProfile({...profile,resign_date:e.target.value})} /></label>
            <label>퇴근시간<input type="time" value={profile.end_time} onChange={e=>setProfile({...profile,end_time:e.target.value})} /></label>
            <button className="primary detailSaveBtn" onClick={saveProfile}>상세 저장</button>
          </div>
          <p className="muted">퇴사 상태는 직원관리 메인에서 상태를 퇴사로 바꾼 뒤 최종저장하세요. 퇴근시간은 오후 프리패스 신청 마감 계산에 사용됩니다.</p>
        </section>

        {['검수자','관리자','최고관리자'].includes(employee.role || '') && (
          <section className="employeeDetailActionSection">
            <h3>검수매장 설정</h3>
            <p className="muted">검수자 또는 관리자가 확인할 매장을 설정합니다.</p>
            <button className="primary" onClick={onOpenReviewStore}>검수매장 설정 열기</button>
          </section>
        )}

        <WorkHistoryInner employee={employee} stores={stores} user={user} />
        </div>
      </div>
    </div>
  );
}

function WorkHistoryInner({ employee, stores, user }) {
  const blankRow = () => ({ store_name: employee.store_name || '', role: employee.role || '직원', start_date: '', end_date: '' });
  const [rows, setRows] = useState([]);
  const [draftRows, setDraftRows] = useState([blankRow()]);
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

  function addDraftRow() { setDraftRows(prev => [...prev, blankRow()]); }
  function removeDraftRow(idx) { setDraftRows(prev => prev.length <= 1 ? [blankRow()] : prev.filter((_, i) => i !== idx)); }
  function updateDraftRow(idx, patch) { setDraftRows(prev => prev.map((r, i) => i === idx ? { ...r, ...patch } : r)); }
  function resetEdit() { setEditingId(null); setDraftRows([blankRow()]); }

  async function saveDraftRow(idx) {
    const form = draftRows[idx];
    if (!form.store_name) return alert('매장을 선택해주세요.');
    if (!form.role) return alert('직책을 선택해주세요.');
    if (!form.start_date) return alert('재입사/근무 시작일을 입력해주세요.');
    if (form.end_date && form.end_date < form.start_date) return alert('퇴사일은 시작일보다 빠를 수 없습니다.');

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

      resetEdit();
      load();
    } catch (e) {
      alert('근무이력 저장 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  function editHistory(row) {
    setEditingId(row.id);
    setDraftRows([{ store_name: row.store_name || '', role: row.role || '직원', start_date: row.start_date || '', end_date: row.end_date || '' }]);
  }

  async function deleteHistory(row) {
    if (!confirm('이 근무이력을 삭제할까요?')) return;
    const { error } = await supabase.from('employee_store_history').delete().eq('id', row.id);
    if (error) return alert(error.message);
    await writeAuditLog('근무이력삭제', 'employee_store_history', row.id, user, `${employee.name} / ${row.store_name} / ${row.role} / ${row.start_date} ~ ${row.end_date || '현재'}`);
    if (editingId === row.id) resetEdit();
    load();
  }

  return (
    <section className="rehireHistorySection">
      <div className="sectionTitleRow">
        <h3>재입사/퇴사 기록</h3>
        {!editingId && <button className="smallAddBtn" type="button" onClick={addDraftRow}>+ 행 추가</button>}
      </div>
      <p className="muted">재입사일은 시작일에 입력하고, 퇴사일을 비워두면 현재 근무중으로 표시됩니다.</p>

      <div className="rehireDraftList">
        {draftRows.map((form, idx) => (
          <div className="rehireDraftRow" key={idx}>
            <select value={form.store_name} onChange={e=>updateDraftRow(idx,{store_name:e.target.value})}>
              <option value="">매장 선택</option>
              {stores.filter(s => s.name !== '관리자').map(s => <option key={s.id || s.name} value={s.name}>{s.name}</option>)}
            </select>
            <select value={form.role} onChange={e=>updateDraftRow(idx,{role:e.target.value})}>
              <option>직원</option>
              <option>점장</option>
              <option>검수자</option>
              <option>관리자</option>
            </select>
            <label>재입사/시작일<input type="date" value={form.start_date} onChange={e=>updateDraftRow(idx,{start_date:e.target.value})} /></label>
            <label>퇴사일<input type="date" value={form.end_date} onChange={e=>updateDraftRow(idx,{end_date:e.target.value})} /></label>
            <button className="primary rehireSaveBtn" type="button" disabled={busy} onClick={()=>saveDraftRow(idx)}>{editingId ? '수정 저장' : '저장'}</button>
            {editingId ? <button className="miniBtn" type="button" onClick={resetEdit}>취소</button> : <button className="miniDangerBtn" type="button" onClick={()=>removeDraftRow(idx)}>삭제</button>}
          </div>
        ))}
      </div>

      <div className="rehireHistoryTableWrap">
        <table className="historyTable rehireHistoryTable">
          <thead><tr><th>매장</th><th>직책</th><th>재입사/시작일</th><th>퇴사일</th><th>관리</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td>{r.store_name}</td>
                <td>{r.role}</td>
                <td>{r.start_date}</td>
                <td>{r.end_date || '현재'}</td>
                <td><div className="historyRowActions compactActions"><button className="miniBtn" onClick={()=>editHistory(r)}>수정</button><button className="miniDangerBtn" onClick={()=>deleteHistory(r)}>삭제</button></div></td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan="5" className="muted">등록된 재입사/퇴사 기록이 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RefusedCustomersViewer() {
  const [rows, setRows] = useState([]);
  const [customersByJoinNo, setCustomersByJoinNo] = useState({});
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const refusedRows = await fetchAllRows('refused_customers', REFUSED_CUSTOMER_LIST_COLUMNS, 'refused_at');
      const joinNos = (refusedRows || []).map(r => r.join_no);
      const [logs, customers] = await Promise.all([
        fetchRowsByValues('happycall_logs', 'join_no', joinNos, HAPPY_CALL_LOG_LIST_COLUMNS),
        fetchRowsByValues('customers', 'join_no', joinNos, CUSTOMER_DISPLAY_COLUMNS, 250)
      ]);
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
      setPage(1);
    } catch (e) {
      alert('통화 불가 고객 조회 오류: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  const pageSize = 100;
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="refusedCustomersPage">
      <h2>통화 불가 고객</h2>
      <div className="sectionCard desktopAuditTableCard">
        <table className="auditLogsTable">
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
            {loading && <tr><td colSpan="5"><InlineLoadingState /></td></tr>}
            {!loading && pageRows.map(r => (
              <tr key={r.id || r.join_no}>
                <td>{formatCustomerJoinNo(r.join_no, customersByJoinNo, r.customer_name)}</td>
                <td>{formatKST(r.refused_at)}</td>
                <td>{r.refused_by || '-'}</td>
                <td>{r.memo || '-'}</td>
                <td>{r.latestLog ? `${r.latestLog.call_result} / ${r.latestLog.call_detail}` : '-'} {hasMinorInfo(r.latestLog || r) && isActiveMinor((r.latestLog || r).minor_birth_date) && <span className="minorBadge">미성년자</span>}</td>
              </tr>
            ))}
            {!loading && !rows.length && <tr><td colSpan="5" className="muted">통화 불가 고객이 없습니다.</td></tr>}
          </tbody>
        </table>
        {!loading && <PaginationBar total={rows.length} page={page} onPageChange={setPage} pageSize={pageSize} />}
      </div>

      <div className="mobileCardList refusedMobileList">
        {loading && <div className="sectionCard pageLoadingPanel"><InlineLoadingState /></div>}
        {!loading && pageRows.map(r => (
          <MobileInfoCard
            key={r.id || r.join_no}
            title={formatCustomerJoinNo(r.join_no, customersByJoinNo, r.customer_name)}
            subtitle={`${formatKST(r.refused_at)} · ${r.refused_by || '처리자 없음'}`}
            meta={[
              r.memo || '메모 없음',
              r.latestLog ? `${r.latestLog.call_result} · ${r.latestLog.call_detail}` : '최신 처리결과 없음'
            ]}
            status={r.latestLog?.call_detail || '통화 불가'}
            badgeClass="rejected"
          />
        ))}
        {!loading && !rows.length && <EmptyStateText>통화 불가 고객이 없습니다.</EmptyStateText>}
        {!loading && <PaginationBar total={rows.length} page={page} onPageChange={setPage} pageSize={pageSize} />}
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
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const data = await fetchAllRows('suggestions', '*', 'created_at');
      let list = data || [];
      if (!isAdminLike(user)) {
        list = list.filter(r => r.requester_name === user.name);
      }
      setRows(list.sort((a,b)=>String(b.created_at || '').localeCompare(String(a.created_at || ''))));
    } catch (e) {
      askErrorReport({ user, currentTab: '건의/문의', actionName: '건의 목록 조회', error: e });
    } finally {
      setLoading(false);
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
      <h2>{isAdminLike(user) ? '건의/문의 관리' : '건의/문의 사항'}</h2>

      {!isAdminLike(user) && (
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
        <input value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder={isAdminLike(user) ? '작성자/매장/제목/내용 검색' : '검색'} />
        <button onClick={()=>{setStatusFilter('전체'); setKeyword('');}}>초기화</button>
      </div>

      <div className="sectionCard suggestionListCard">
        {loading && <InlineLoadingState />}
        {!loading && !filtered.length && <div className="emptyState">건의/문의 내역이 없습니다.</div>}
        {!loading && filtered.map(r => (
          <button key={r.id} type="button" className="suggestionCardItem" onClick={() => setSelected(r)}>
            <span className="suggestionDate">{formatKST(r.created_at)}</span>
            <strong>{r.title}</strong>
            <span className="suggestionMeta">
              {isAdminLike(user) ? `${r.requester_name || '-'} · ${r.requester_store || '-'}` : r.category}
            </span>
            <span className={`suggestionStatus ${String(r.status || '접수').replace(/\s/g,'')}`}>{r.status || '접수'}</span>
          </button>
        ))}
      </div>

      {selected && <SuggestionAdminModal row={selected} user={user} onClose={() => setSelected(null)} onSave={updateSuggestion} />}
    </div>
  );
}

function SuggestionAdminModal({ row, user, onClose, onSave }) {
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

        {isAdminLike(user) ? (
          <section className="suggestionAdminEdit">
            <h3>관리자 처리</h3>
            <select value={status} onChange={e=>setStatus(e.target.value)}>
              <option>접수</option>
              <option>확인중</option>
              <option>반영예정</option>
              <option>반영완료</option>
              <option>보류</option>
            </select>
            <textarea value={comment} onChange={e=>setComment(e.target.value)} placeholder="관리자 코멘트 입력" />
            <button className="primary" onClick={() => onSave(row, { status, admin_comment: comment })}>처리 내용 저장</button>
          </section>
        ) : (
          <section>
            <h3>처리 내역</h3>
            <p><b>상태</b><br />{row.status || '접수'}</p>
            <p><b>관리자 코멘트</b><br />{row.admin_comment || '아직 관리자 코멘트가 없습니다.'}</p>
          </section>
        )}
      </div>
    </div>
  );
}



function ErrorReportsViewer({ user }) {
  const [rows, setRows] = useState([]);
  const [statusFilter, setStatusFilter] = useState('전체');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data } = await runNetworkRead(() => supabase
        .from('error_reports')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500));
      setRows(data || []);
    } catch (e) {
      alert('오류보고 조회 오류: ' + e.message);
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(row, status) {
    const { error } = await supabase.from('error_reports').update({ status }).eq('id', row.id);
    if (error) return alert(error.message);
    await writeAuditLog('오류보고상태변경', 'error_reports', row.id, user, `${row.reporter_name} / ${status}`);
    setRows(prev => prev.map(x => x.id === row.id ? { ...x, status } : x));
    setSelected(prev => prev && prev.id === row.id ? { ...prev, status } : prev);
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
      <div className="sectionCard errorTableCard desktopErrorTableCard">
        <div className="errorTableScroll">
        <table className="errorReportsTable">
          <thead>
            <tr>
              <th>일시(KST)</th><th>횟수</th><th>보고자</th><th>권한</th><th>매장</th><th>작업</th><th>가입번호</th><th>오류내용</th><th>상태</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="9"><InlineLoadingState /></td></tr>}
            {!loading && filtered.map(r => (
              <tr key={r.id}>
                <td>{formatKST(r.created_at)}</td><td>{r.occurrence_count || 1}</td>
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
            {!loading && !filtered.length && <tr><td colSpan="9" className="muted">오류보고가 없습니다.</td></tr>}
          </tbody>
        </table>
        </div>
      </div>

      <div className="mobileCardList errorMobileList">
        {loading && <InlineLoadingState />}
        {!loading && filtered.map(r => (
          <MobileInfoCard
            key={r.id}
            title={`${r.reporter_name || '-'} · ${r.action_name || '-'}`}
            subtitle={`${r.reporter_store || '-'} · ${formatKST(r.created_at)}`}
            meta={[r.current_tab || '-', r.error_message || '-']}
            status={r.status || '접수'}
            badgeClass={(r.status || '접수') === '해결완료' ? 'approved' : (r.status || '접수') === '보류' ? 'rejected' : 'waiting'}
            onClick={() => setSelected(r)}
          />
        ))}
        {!loading && !filtered.length && <EmptyStateText>오류보고가 없습니다.</EmptyStateText>}
      </div>

      {selected && <ErrorReportDetailModal row={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function ErrorReportDetailModal({ row, onClose }) {
  useModalBodyScrollLock();
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
    <div className="modalBg errorDetailModalBg">
      <div className="modal errorDetailModal">
        <div className="modalHead">
          <h2>오류보고 상세</h2>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="errorDetailBody">

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
    </div>
  );
}

function AuditLogsViewer() {
  const [logs, setLogs] = useState([]);
  const [actorFilter, setActorFilter] = useState('전체');
  const [actionFilter, setActionFilter] = useState('전체');
  const [keyword, setKeyword] = useState('');
  const [loading,setLoading]=useState(true);
  const [processingId,setProcessingId]=useState(null);
  const [selectedLog, setSelectedLog] = useState(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const { data: rows } = await runNetworkRead(() => supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500));
      setLogs(rows || []);
    } catch (e) {
      alert('감사로그 조회 오류: ' + e.message);
    } finally {
      setLoading(false);
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
      <div className="sectionCard desktopAuditTableCard">
        <table>
          <thead>
            <tr><th>일시(KST)</th><th>작업자</th><th>작업</th><th>상세</th></tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="4"><InlineLoadingState /></td></tr>}
            {!loading && filteredLogs.map(l => (
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

      <div className="mobileCardList auditMobileList">
        {loading && <InlineLoadingState />}
        {!loading && filteredLogs.map(l => (
          <MobileInfoCard
            key={l.id}
            title={`${l.actor_name || '-'} · ${l.action || '-'}`}
            subtitle={formatKST(l.created_at)}
            meta={[maskSensitiveAuditDetail(l.detail || `${l.target_type || ''} ${l.target_id || ''}`)]}
            status="상세"
            badgeClass="finalWaiting"
            onClick={() => setSelectedLog(l)}
          />
        ))}
        {!loading && !filteredLogs.length && <EmptyStateText>조건에 맞는 감사로그가 없습니다.</EmptyStateText>}
      </div>

      {selectedLog && (
        <div className="modalBg auditDetailModalBg" onMouseDown={e => { if (e.target === e.currentTarget) setSelectedLog(null); }}>
          <div className="modal auditDetailModal">
            <div className="modalHead"><h2>감사로그 상세</h2><button onClick={() => setSelectedLog(null)}>닫기</button></div>
            <div className="auditDetailBody">
              <div className="infoGrid">
                <p><b>일시</b><br />{formatKST(selectedLog.created_at)}</p>
                <p><b>작업자</b><br />{selectedLog.actor_name || '-'}</p>
                <p><b>작업</b><br />{selectedLog.action || '-'}</p>
                <p><b>대상</b><br />{selectedLog.target_type || '-'} {selectedLog.target_id || ''}</p>
              </div>
              <section><h3>상세 내용</h3><div className="auditDetailText">{maskSensitiveAuditDetail(selectedLog.detail || '-')}</div></section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmployeePerformanceDashboard({ user, mode = 'all' }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { load(); }, [mode]);

  async function load() {
    setLoading(true);
    try {
      let allTargets;
      if (mode === 'store') {
        const { data } = await runNetworkRead(() => supabase
          .from('happycall_targets')
          .select(HAPPY_CALL_TARGET_LIST_COLUMNS)
          .eq('assigned_store', user.store_name)
          .order('target_date', { ascending: true }));
        allTargets = data || [];
      } else {
        allTargets = await fetchAllRows('happycall_targets', HAPPY_CALL_TARGET_LIST_COLUMNS, 'target_date');
      }

      let visible = (allTargets || []).filter(isVisibleHappycallTarget);
      if (mode === 'store') visible = visible.filter(t => t.assigned_store === user.store_name);

      const allLogs = mode === 'store'
        ? await fetchRowsByValues('happycall_logs', 'target_id', visible.map(t => t.id), HAPPY_CALL_LOG_LIST_COLUMNS)
        : await fetchAllRows('happycall_logs', HAPPY_CALL_LOG_LIST_COLUMNS, 'checked_at');
      setTargets(visible);
      setLogs(allLogs || []);
    } catch (e) {
      alert('직원별 현황 조회 오류: ' + e.message);
    } finally {
      setLoading(false);
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
      const log = latestLogByTarget[t.id];
      if (!log && effectiveTargetDate(t) > todayLocalISO()) return;
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
      r.total += 1;

      if (effectiveTargetDate(t) === todayLocalISO()) {
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
        if (diffDays(effectiveTargetDate(t)) > 0) r.overdue += 1;
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
    const sumPending = list.reduce((a,r)=>a+r.pending,0);
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
      { label: '인원', x: tableX + 18, w: 170 },
      { label: '매장', x: tableX + 206, w: 110 },
      { label: '대상건', x: tableX + 336, w: 90 },
      { label: '완료건', x: tableX + 446, w: 90 },
      { label: '미완료', x: tableX + 556, w: 90 },
      { label: '완료율', x: tableX + 674, w: 150 },
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
      ctx.fillStyle = '#dc2626';
      ctx.font = 'bold 15px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(`${r.pending}건`, cols[4].x, yText);

      const rateBg = rRate >= 80 ? '#fef3c7' : rRate >= 50 ? '#ffedd5' : '#fee2e2';
      const rateColor = rRate >= 80 ? '#92400e' : rRate >= 50 ? '#9a3412' : '#991b1b';
      ctx.fillStyle = rateBg;
      roundRect(cols[5].x - 10, yTop + 11, 92, 30, 15);
      ctx.fill();
      ctx.fillStyle = rateColor;
      ctx.font = 'bold 15px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      ctx.fillText(`${rRate}%`, cols[5].x, yText);
    });

    const footerY = tableTop + headerH + (list.length * rowH) + 18;
    ctx.fillStyle = '#eff6ff';
    roundRect(tableX, footerY, tableW, 48, 14);
    ctx.fill();

    ctx.fillStyle = '#1e3a8a';
    ctx.font = 'bold 16px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`총 대상 ${sumTotal}건`, tableX + 20, footerY + 31);
    ctx.fillText(`총 완료 ${sumDone}건`, tableX + 190, footerY + 31);
    ctx.fillStyle = '#b91c1c';
    ctx.fillText(`총 미완료 ${sumPending}건`, tableX + 350, footerY + 31);
    ctx.fillStyle = '#1e3a8a';
    ctx.fillText(`전체 완료율 ${rate}%`, tableX + 540, footerY + 31);

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
    <div className="employeePerformancePage">
      <h2>{mode === 'store' ? `${user.store_name} 직원별 해피콜 현황` : '직원별 해피콜 현황'}</h2>
      <button className="primary copyStatusBtn" onClick={copyIncompleteRows}>미완료자 이미지 복사</button>
      {loading ? (
        <div className="sectionCard pageLoadingPanel"><InlineLoadingState /></div>
      ) : (<>
      <div className="stats">
        <Card title="전체 대상" value={total.total} />
        <Card title="전체 완료율" value={`${total.total ? Math.round(total.done / total.total * 1000) / 10 : 0}%`} />
        <Card title="경과 미완료" value={total.overdue} />
        <Card title="반려" value={total.rejected} />
      </div>

      <div className="sectionCard desktopEmployeePerformanceTable">
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

      <div className="mobileCardList employeePerformanceMobileList">
        {rows.map(r => {
          const rate = r.total ? Math.round(r.done / r.total * 1000) / 10 : 0;
          return (
            <MobileInfoCard
              key={r.name}
              title={r.name}
              subtitle={`${r.store || '-'} · 전체 ${r.total}건 · 완료 ${r.done}건`}
              meta={[
                `미완료 ${r.pending}건 · 경과 ${r.overdue}건`,
                `오늘 ${r.todayDone}/${r.todayTotal}건 · 검수대기 ${r.reviewPending}건`
              ]}
              status={`${rate}%`}
              badgeClass={rate >= 100 ? 'approved' : rate >= 90 ? 'waiting' : 'rejected'}
            />
          );
        })}
        {!rows.length && <EmptyStateText>표시할 현황이 없습니다.</EmptyStateText>}
      </div>
      </>)}
    </div>
  );
}

function HappycallAssignmentStatus({ user }) {
  const [employees, setEmployees] = useState([]);
  const [assignableEmployees, setAssignableEmployees] = useState([]);
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [customersByJoinNo, setCustomersByJoinNo] = useState({});
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [targetEmployeeId, setTargetEmployeeId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [statusFilter, setStatusFilter] = useState('미완료전체');
  const [assignmentMode, setAssignmentMode] = useState('customers');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => { load(); }, []);

  function customerAssigneeName(c) {
    return c?.seller_name || c?.assigned_employee || c?.employee_name || '';
  }

  function customerStoreName(c) {
    return c?.store_name || c?.assigned_store || '';
  }

  function customerDisplayName(c) {
    return c?.customer_name || c?.name || c?.customer_name_masked || '-';
  }

  function currentAssigneeName(t) {
    return t.temporary_assignee || t.assigned_employee || '';
  }

  function currentAssigneeStore(t) {
    return t.temporary_assignee ? (t.temporary_assignee_store || t.assigned_store) : t.assigned_store;
  }

  async function load() {
    try {
      const [empData, targetData, logData, customerData] = await Promise.all([
        fetchAllRows('employees', 'id,name,store_name,status,role,happycall_enabled,happycall_assignment_enabled', 'name'),
        fetchAllRows('happycall_targets', HAPPY_CALL_TARGET_LIST_COLUMNS, 'target_date'),
        fetchAllRows('happycall_logs', HAPPY_CALL_LOG_LIST_COLUMNS, 'checked_at'),
        fetchAllRows('customers', CUSTOMER_DISPLAY_COLUMNS, 'open_date')
      ]);

      const validTargets = (targetData || []).filter(isVisibleHappycallTarget);
      const normalizedEmployees = (empData || []).map(e => ({ ...e, store_name: normalizeOfficeStoreName(e.store_name) }));
      const permanentAssignedNames = new Set(validTargets.map(t => t.assigned_employee).filter(Boolean));
      const currentHappycallNames = new Set(validTargets.map(t => currentAssigneeName(t)).filter(Boolean));

      const visibleEmployees = normalizedEmployees
        .filter(e => permanentAssignedNames.has(e.name) || currentHappycallNames.has(e.name))
        .sort((a,b)=>String(a.store_name || '').localeCompare(String(b.store_name || ''), 'ko') || String(a.name || '').localeCompare(String(b.name || ''), 'ko'));

      const assignable = normalizedEmployees
        .filter(e => isHappycallAssignableEmployee(e))
        .sort((a,b)=>String(a.store_name || '').localeCompare(String(b.store_name || ''), 'ko') || String(a.name || '').localeCompare(String(b.name || ''), 'ko'));

      setEmployees(visibleEmployees);
      setAssignableEmployees(assignable);
      setTargets(validTargets);
      setLogs(logData || []);
      setCustomers(customerData || []);
      const latestCustomers = makeLatestCustomerRecords(customerData || []);
      setCustomersByJoinNo(Object.fromEntries(latestCustomers.map(c => [c.join_no, c])));
      setPage(1);
      if ((!selectedEmployee || !visibleEmployees.some(e => e.name === selectedEmployee)) && visibleEmployees.length) setSelectedEmployee(visibleEmployees[0].name);
    } catch (e) {
      askErrorReport({ user, currentTab:'배정 현황', actionName:'배정 현황 조회', error:e });
    }
  }

  function makeLatestCustomerRecords(rows) {
    const sorted = [...(rows || [])].sort((a,b) =>
      String(b.open_date || '').localeCompare(String(a.open_date || '')) || String(b.id || '').localeCompare(String(a.id || ''))
    );
    const map = new Map();
    sorted.forEach(c => {
      const key = String(c.join_no || '').trim();
      if (key && !map.has(key)) map.set(key, c);
    });
    return Array.from(map.values());
  }

  const latestLogByTarget = useMemo(() => {
    const map = {};
    logs.forEach(l => {
      const prev = map[l.target_id];
      if (!prev || String(l.checked_at || '') > String(prev.checked_at || '')) map[l.target_id] = l;
    });
    return map;
  }, [logs]);

  const latestCustomerRecords = useMemo(() => makeLatestCustomerRecords(customers), [customers]);

  const permanentAssigneeByJoinNo = useMemo(() => {
    const sorted = [...(targets || [])].sort((a,b) =>
      String(b.target_date || '').localeCompare(String(a.target_date || '')) || String(b.id || '').localeCompare(String(a.id || ''))
    );
    const map = new Map();
    sorted.forEach(t => {
      const key = String(t.join_no || '').trim();
      if (key && !map.has(key) && t.assigned_employee) {
        map.set(key, { name: t.assigned_employee, store: t.assigned_store || '' });
      }
    });
    return map;
  }, [targets]);

  const customerCounts = useMemo(() => {
    const map = {};
    employees.forEach(e => { map[e.name] = { customers:0 }; });
    latestCustomerRecords.forEach(c => {
      const assigned = permanentAssigneeByJoinNo.get(String(c.join_no || '').trim());
      const name = assigned?.name;
      if (!name) return;
      if (!map[name]) map[name] = { customers:0 };
      map[name].customers += 1;
    });
    return map;
  }, [employees, latestCustomerRecords, permanentAssigneeByJoinNo]);

  const happycallCounts = useMemo(() => {
    const map = {};
    employees.forEach(e => { map[e.name] = { total:0, pending:0, done:0, rejected:0 }; });
    targets.forEach(t => {
      const name = currentAssigneeName(t) || '미지정';
      if (!map[name]) map[name] = { total:0, pending:0, done:0, rejected:0 };
      const latest = latestLogByTarget[t.id];
      map[name].total += 1;
      if (latest?.review_status === '반려') map[name].rejected += 1;
      else if (latest) map[name].done += 1;
      else map[name].pending += 1;
    });
    return map;
  }, [employees, targets, latestLogByTarget]);

  const selectedCustomerRecords = useMemo(() => {
    let list = latestCustomerRecords.filter(c => permanentAssigneeByJoinNo.get(String(c.join_no || '').trim())?.name === selectedEmployee);
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter(c => `${c.join_no || ''} ${customerDisplayName(c)} ${customerStoreName(c)} ${c.open_date || ''}`.toLowerCase().includes(kw));
    }
    return list.sort((a,b)=>String(b.open_date || '').localeCompare(String(a.open_date || '')) || String(a.join_no || '').localeCompare(String(b.join_no || '')));
  }, [latestCustomerRecords, selectedEmployee, keyword, permanentAssigneeByJoinNo]);

  const selectedHappycallTargets = useMemo(() => {
    let list = targets.filter(t => currentAssigneeName(t) === selectedEmployee);
    if (statusFilter !== '전체') {
      list = list.filter(t => {
        const latest = latestLogByTarget[t.id];
        if (statusFilter === '검수반려') return latest?.review_status === '반려';
        if (statusFilter === '완료') return !!latest && latest.review_status !== '반려';
        if (statusFilter === '미완료전체') return !latest || latest.review_status === '반려';
        return true;
      });
    }
    const kw = keyword.trim().toLowerCase();
    if (kw) {
      list = list.filter(t => {
        const c = customersByJoinNo[t.join_no] || {};
        return `${t.join_no || ''} ${customerDisplayName(c)} ${t.assigned_store || ''} ${t.call_type || t.target_type || ''}`.toLowerCase().includes(kw);
      });
    }
    return list.sort((a,b)=>String(a.target_date || '').localeCompare(String(b.target_date || '')));
  }, [targets, selectedEmployee, statusFilter, keyword, latestLogByTarget, customersByJoinNo]);

  const visibleRows = assignmentMode === 'customers' ? selectedCustomerRecords : selectedHappycallTargets;
  const rowKey = row => assignmentMode === 'customers' ? String(row.join_no) : row.id;
  const pageSize = 100;
  const pageRows = visibleRows.slice((page - 1) * pageSize, page * pageSize);
  const allSelected = pageRows.length > 0 && pageRows.every(row => selectedIds.includes(rowKey(row)));

  useEffect(() => { setPage(1); }, [assignmentMode, selectedEmployee, statusFilter, keyword]);

  function changeMode(mode) {
    setAssignmentMode(mode);
    setSelectedIds([]);
    setTargetEmployeeId('');
  }

  function toggleSelected(id) {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function toggleAll(checked) {
    const ids = pageRows.map(rowKey);
    setSelectedIds(prev => checked ? Array.from(new Set([...prev, ...ids])) : prev.filter(id => !ids.includes(id)));
  }

  async function reassignSelectedCustomers() {
    const rows = selectedCustomerRecords.filter(c => selectedIds.includes(String(c.join_no)));
    if (!rows.length) return alert('담당자를 변경할 고객을 선택해주세요.');
    const targetEmp = employees.find(e => String(e.id) === String(targetEmployeeId));
    if (!targetEmp) return alert('변경할 담당자를 선택해주세요.');
    const joinNos = rows.map(c => String(c.join_no));
    if (!confirm(`선택한 고객 ${rows.length}명의 담당자를\n\n${selectedEmployee} → ${targetEmp.name}\n\n으로 영구 변경할까요?\n\n※ 이후 생성되는 모든 해피콜은 새 담당자 기준으로 생성됩니다.`)) return;

    setBusy(true);
    try {
      const { error } = await supabase.from('customers').update({
        seller_name: targetEmp.name,
        store_name: targetEmp.store_name
      }).in('join_no', joinNos);
      if (error) throw error;

      await writeAuditLog('고객담당자영구변경', 'customers', 'bulk', user, `${rows.length}명 / ${selectedEmployee} → ${targetEmp.store_name} · ${targetEmp.name}`);
      alert(`${rows.length}명의 고객 담당자가 ${targetEmp.name}님으로 변경되었습니다.`);
      setSelectedIds([]);
      setTargetEmployeeId('');
      load();
    } catch (e) {
      askErrorReport({ user, currentTab:'배정 현황', actionName:'고객 담당자 영구 변경', error:e });
    } finally {
      setBusy(false);
    }
  }

  async function reassignSelectedHappycalls() {
    const rows = selectedHappycallTargets.filter(t => selectedIds.includes(t.id));
    if (!rows.length) return alert('재배정할 해피콜을 선택해주세요.');
    const targetEmp = employees.find(e => String(e.id) === String(targetEmployeeId));
    if (!targetEmp) return alert('해피콜 처리자를 선택해주세요.');
    if (!confirm(`선택한 해피콜 ${rows.length}건을\n\n${selectedEmployee} → ${targetEmp.name}\n\n으로 1회 변경할까요?\n\n※ 이번에 생성된 해피콜에만 적용됩니다. 고객 담당자는 변경되지 않습니다.`)) return;

    setBusy(true);
    try {
      const { error } = await supabase.from('happycall_targets').update({
        temporary_assignee: targetEmp.name,
        temporary_assignee_store: targetEmp.store_name
      }).in('id', rows.map(t => t.id));
      if (error) throw error;

      await writeAuditLog('해피콜일회성재배정', 'happycall_targets', 'bulk', user, `${rows.length}건 / ${selectedEmployee} → ${targetEmp.store_name} · ${targetEmp.name}`);
      alert(`${rows.length}건의 해피콜 처리자가 ${targetEmp.name}님으로 변경되었습니다.`);
      setSelectedIds([]);
      setTargetEmployeeId('');
      load();
    } catch (e) {
      askErrorReport({ user, currentTab:'배정 현황', actionName:'해피콜 1회 재배정', error:e });
    } finally {
      setBusy(false);
    }
  }

  const activeTargetEmployees = assignableEmployees.filter(e => e.name !== selectedEmployee);
  const selectedHappyCount = happycallCounts[selectedEmployee] || { total:0, pending:0, rejected:0 };
  const selectedCustomerCount = customerCounts[selectedEmployee]?.customers || 0;

  return (
    <div className="assignmentStatusPage">
      <h2>해피콜 배정 현황</h2>
      <div className="sectionCard assignmentControlBar">
        <select value={selectedEmployee} onChange={e=>{setSelectedEmployee(e.target.value); setSelectedIds([]); setTargetEmployeeId('');}}>
          {employees.map(e => {
            const hc = happycallCounts[e.name] || { total:0 };
            const cc = customerCounts[e.name]?.customers || 0;
            const count = assignmentMode === 'customers' ? cc : hc.total;
            return <option key={e.id || e.name} value={e.name}>{displayStoreNameForUi(e.store_name)} · {e.name} · {count}건</option>;
          })}
        </select>
        {assignmentMode === 'happycalls' ? (
          <select value={statusFilter} onChange={e=>{setStatusFilter(e.target.value); setSelectedIds([]);}}>
            <option value="미완료전체">미완료+반려</option>
            <option value="완료">완료</option>
            <option value="검수반려">반려</option>
            <option value="전체">전체</option>
          </select>
        ) : (
          <div className="assignmentModeHint">담당 고객 전체</div>
        )}
        <input value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder="가입번호/고객명/매장 검색" />
      </div>

      <div className="assignmentGrid">
        <div className="sectionCard assignmentEmployeeList">
          <h3>직원별 배정</h3>
          {employees.map(e => {
            const hc = happycallCounts[e.name] || { total:0, pending:0, rejected:0 };
            const cc = customerCounts[e.name]?.customers || 0;
            return (
              <button key={e.id || e.name} className={selectedEmployee===e.name?'active':''} onClick={()=>{setSelectedEmployee(e.name); setSelectedIds([]); setTargetEmployeeId('');}}>
                <div className="assignmentEmployeeTop">
                  <b>{e.name}</b>
                  <span>{displayStoreNameForUi(e.store_name)} · {e.role || '직원'}</span>
                </div>
                <div className="assignmentEmployeeStats twoMode">
                  <span><strong>{cc}</strong><small>고객</small></span>
                  <span><strong>{hc.total || 0}</strong><small>해피콜</small></span>
                  <span><strong>{hc.pending || 0}</strong><small>미완료</small></span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="sectionCard assignmentTargetList">
          <div className="assignmentModeTabs">
            <button className={assignmentMode === 'customers' ? 'active' : ''} onClick={()=>changeMode('customers')}>배정된 고객</button>
            <button className={assignmentMode === 'happycalls' ? 'active' : ''} onClick={()=>changeMode('happycalls')}>배정된 해피콜</button>
          </div>

          <div className="assignmentModeDescription">
            {assignmentMode === 'customers' ? (
              <p><b>고객의 담당자를 영구적으로 변경합니다.</b> 이후 생성되는 모든 해피콜도 변경된 담당자를 기준으로 배정됩니다.</p>
            ) : (
              <p><b>배정된 해피콜 담당자만 1회 변경합니다.</b> 고객 담당자가 영구적으로 변경되는 것은 아닙니다.</p>
            )}
          </div>

          <div className="assignmentListHead">
            <div>
              <h3>{selectedEmployee || '-'} {assignmentMode === 'customers' ? '배정 고객' : '배정 해피콜'}</h3>
              <div className="assignmentSummaryBadges">
                <span><b>{selectedIds.length}</b>선택</span>
                <span><b>{visibleRows.length}</b>표시</span>
                <span><b>{selectedCustomerCount}</b>담당고객</span>
                <span><b>{selectedHappyCount.total || 0}</b>담당해피콜</span>
              </div>
            </div>
            <div className="assignmentReassignBox">
              <select value={targetEmployeeId} onChange={e=>setTargetEmployeeId(e.target.value)}>
                <option value="">{assignmentMode === 'customers' ? '변경할 담당자 선택' : '1회 처리자 선택'}</option>
                {activeTargetEmployees.map(e => <option key={e.id} value={e.id}>{displayStoreNameForUi(e.store_name)} · {e.name}</option>)}
              </select>
              <button className="primary" disabled={busy || !selectedIds.length || !targetEmployeeId} onClick={assignmentMode === 'customers' ? reassignSelectedCustomers : reassignSelectedHappycalls}>
                {assignmentMode === 'customers' ? '선택 고객 영구 변경' : '선택 해피콜 재배정'}
              </button>
            </div>
          </div>

          <div className="assignmentTableWrap">
            <table className="assignmentStatusTable assignmentDualTable">
              {assignmentMode === 'customers' ? (
                <>
                  <thead>
                    <tr>
                      <th className="checkCol"><input type="checkbox" checked={allSelected} onChange={e=>toggleAll(e.target.checked)} /></th>
                      <th>가입번호</th>
                      <th>고객명</th>
                      <th>담당매장</th>
                      <th>최근 개통일</th>
                      <th>현재 담당자</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(c => {
                      const id = String(c.join_no);
                      return (
                        <tr key={id}>
                          <td className="checkCol"><input type="checkbox" checked={selectedIds.includes(id)} onChange={()=>toggleSelected(id)} /></td>
                          <td>{formatCustomerJoinNo(c.join_no, customersByJoinNo, customerDisplayName(c))}</td>
                          <td>{customerDisplayName(c)}</td>
                          <td>{displayStoreNameForUi(permanentAssigneeByJoinNo.get(String(c.join_no || '').trim())?.store) || '-'}</td>
                          <td>{c.open_date || '-'}</td>
                          <td>{permanentAssigneeByJoinNo.get(String(c.join_no || '').trim())?.name || '-'}</td>
                        </tr>
                      );
                    })}
                    {!selectedCustomerRecords.length && <tr><td colSpan="6" className="muted">표시할 배정 고객이 없습니다.</td></tr>}
                  </tbody>
                </>
              ) : (
                <>
                  <thead>
                    <tr>
                      <th className="checkCol"><input type="checkbox" checked={allSelected} onChange={e=>toggleAll(e.target.checked)} /></th>
                      <th>가입번호</th>
                      <th>고객명</th>
                      <th>매장</th>
                      <th>대상일</th>
                      <th>유형</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(t => {
                      const latest = latestLogByTarget[t.id];
                      const c = customersByJoinNo[t.join_no] || {};
                      const state = latest?.review_status === '반려' ? '반려' : latest ? '완료' : '미완료';
                      return (
                        <tr key={t.id}>
                          <td className="checkCol"><input type="checkbox" checked={selectedIds.includes(t.id)} onChange={()=>toggleSelected(t.id)} /></td>
                          <td>{formatCustomerJoinNo(t.join_no, customersByJoinNo, t.customer_name)}</td>
                          <td>{customerDisplayName(c)}</td>
                          <td>{displayStoreNameForUi(currentAssigneeStore(t)) || '-'}</td>
                          <td>{effectiveTargetDate(t) || '-'}</td>
                          <td>{callTypeLabel(t.call_type || t.target_type || '-')}</td>
                          <td>{state}</td>
                        </tr>
                      );
                    })}
                    {!selectedHappycallTargets.length && <tr><td colSpan="7" className="muted">표시할 배정 해피콜이 없습니다.</td></tr>}
                  </tbody>
                </>
              )}
            </table>
          </div>
          <PaginationBar total={visibleRows.length} page={page} onPageChange={setPage} pageSize={pageSize} />
        </div>
      </div>
    </div>
  );
}

function ReviewDashboard({ user }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [customersByJoinNo, setCustomersByJoinNo] = useState({});
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('검수대기');
  const [employeeFilter, setEmployeeFilter] = useState('전체');
  const [storeFilter, setStoreFilter] = useState('전체');
  const [keyword, setKeyword] = useState('');
  const [selectedReviewIds, setSelectedReviewIds] = useState([]);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [page, setPage] = useState(1);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      let allowedStores = null;
      if (user.role === '검수자') {
        const { data: permissions } = await runNetworkRead(() => supabase
          .from('reviewer_store_permissions')
          .select('store_name')
          .eq('employee_id', user.id));
        allowedStores = (permissions || []).map(p => p.store_name).filter(Boolean);
      }

      let allTargets = [];
      if (allowedStores && !allowedStores.length) {
        allTargets = [];
      } else if (allowedStores) {
        const { data } = await runNetworkRead(() => supabase
          .from('happycall_targets')
          .select(HAPPY_CALL_TARGET_LIST_COLUMNS)
          .in('assigned_store', allowedStores)
          .order('target_date', { ascending: true }));
        allTargets = data || [];
      } else {
        allTargets = await fetchAllRows('happycall_targets', HAPPY_CALL_TARGET_LIST_COLUMNS, 'target_date');
      }

      const visibleTargets = (allTargets || []).filter(isVisibleHappycallTarget);
      const targetIds = visibleTargets.map(t => t.id);
      const allLogs = allowedStores
        ? await fetchRowsByValues('happycall_logs', 'target_id', targetIds, HAPPY_CALL_LOG_LIST_COLUMNS)
        : await fetchAllRows('happycall_logs', HAPPY_CALL_LOG_LIST_COLUMNS, 'checked_at');
      const customers = allowedStores
        ? await fetchRowsByValues('customers', 'join_no', visibleTargets.map(t => t.join_no), CUSTOMER_DISPLAY_COLUMNS, 250)
        : await fetchAllRows('customers', CUSTOMER_DISPLAY_COLUMNS, 'open_date');
      setCustomersByJoinNo(Object.fromEntries((customers || []).map(c => [c.join_no, c])));

      setTargets(visibleTargets);
      setLogs(allLogs || []);
      setPage(1);
    } catch (e) {
      askErrorReport({ user, currentTab: '검수', actionName: '검수 목록 조회', error: e });
    } finally {
      setLoading(false);
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

  useEffect(() => { setPage(1); }, [filter, employeeFilter, storeFilter, keyword]);
  const pageSize = 100;
  const pageReviewRows = reviewRows.slice((page - 1) * pageSize, page * pageSize);

  const stats = useMemo(() => {
    const total = baseRows.length;
    const pending = baseRows.filter(r => (r.log.review_status || '검수대기') === '검수대기').length;
    const approved = baseRows.filter(r => r.log.review_status === '검수완료').length;
    const rejected = baseRows.filter(r => r.log.review_status === '반려').length;
    return { total, pending, approved, rejected };
  }, [baseRows]);


  const selectableReviewRows = useMemo(() => reviewRows.filter(r => (r.log.review_status || '검수대기') === '검수대기'), [reviewRows]);
  const allVisibleSelected = selectableReviewRows.length > 0 && selectableReviewRows.every(r => selectedReviewIds.includes(r.log.id));

  function toggleReviewSelection(id) {
    setSelectedReviewIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function toggleAllVisibleReviews(checked) {
    const ids = selectableReviewRows.map(r => r.log.id);
    setSelectedReviewIds(prev => checked ? Array.from(new Set([...prev, ...ids])) : prev.filter(id => !ids.includes(id)));
  }

  async function bulkApproveReviews() {
    const rows = baseRows.filter(r => selectedReviewIds.includes(r.log.id) && (r.log.review_status || '검수대기') === '검수대기');
    if (!rows.length) return alert('일괄 승인할 검수대기 건을 선택해주세요.');
    if (!confirm(`${rows.length}건을 일괄 검수 승인할까요?\n확인 후 반영됩니다.`)) return;

    setBulkBusy(true);
    try {
      const now = new Date().toISOString();
      const ids = rows.map(r => r.log.id);
      const { error } = await supabase.from('happycall_logs').update({
        review_status: '검수완료',
        reviewed_by: user.name,
        reviewed_at: now
      }).in('id', ids);
      if (error) throw error;
      await writeAuditLog('검수일괄완료', 'happycall_log', 'bulk', user, `${rows.length}건 일괄 승인`);
      alert(`${rows.length}건 검수 완료 처리되었습니다.`);
      setSelectedReviewIds([]);
      load();
    } catch (e) {
      askErrorReport({ user, currentTab: '검수', actionName: '일괄 검수 승인', error: e });
    } finally {
      setBulkBusy(false);
    }
  }

  async function bulkRejectReviews() {
    const rows = baseRows.filter(r => selectedReviewIds.includes(r.log.id) && (r.log.review_status || '검수대기') === '검수대기');
    if (!rows.length) return alert('일괄 반려할 검수대기 건을 선택해주세요.');
    const memo = prompt('일괄 반려 사유를 입력해주세요.');
    if (!memo || !memo.trim()) return;
    if (!confirm(`${rows.length}건을 일괄 반려할까요?\n반려 사유: ${memo}`)) return;

    setBulkBusy(true);
    try {
      const now = new Date().toISOString();
      const ids = rows.map(r => r.log.id);
      const { error } = await supabase.from('happycall_logs').update({
        review_status: '반려',
        reviewed_by: user.name,
        reviewed_at: now,
        review_memo: memo
      }).in('id', ids);
      if (error) throw error;

      for (const { log, target } of rows) {
        if (isUnavailableCall(log.call_result, log.call_detail)) {
          await supabase.from('refused_customers').delete().eq('join_no', target.join_no);
        }
      }

      await writeAuditLog('검수일괄반려', 'happycall_log', 'bulk', user, `${rows.length}건 일괄 반려 / ${memo}`);
      alert(`${rows.length}건 반려 처리되었습니다.`);
      setSelectedReviewIds([]);
      load();
    } catch (e) {
      askErrorReport({ user, currentTab: '검수', actionName: '일괄 검수 반려', error: e });
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <div>
      <h2>검수</h2>
      {loading ? (
        <div className="sectionCard pageLoadingPanel"><InlineLoadingState /></div>
      ) : (<>

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

      <div className="sectionCard reviewBulkBar">
        <div className="reviewBulkInfo">
          <b>선택 {selectedReviewIds.length}건</b>
          <span className="muted">체크 후 선택 승인 또는 선택 반려를 눌러주세요.</span>
        </div>
        <div className="reviewBulkActions">
          <button className="primary" disabled={bulkBusy || !selectedReviewIds.length} onClick={bulkApproveReviews}>선택 승인</button>
          <button className="dangerBtn" disabled={bulkBusy || !selectedReviewIds.length} onClick={bulkRejectReviews}>선택 반려</button>
        </div>
      </div>

      <div className="sectionCard reviewListCard">
        <table className="reviewTable">
          <thead>
            <tr>
              <th className="checkCol"><input type="checkbox" checked={allVisibleSelected} onChange={e=>toggleAllVisibleReviews(e.target.checked)} /></th>
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
            {pageReviewRows.map(({log, target}) => (
              <tr key={log.id} className="clickableRow" onClick={()=>setSelected({log, target, allLogs: logs})}>
                <td className="checkCol" onClick={e=>e.stopPropagation()}>{(log.review_status || '검수대기') === '검수대기' ? <input type="checkbox" checked={selectedReviewIds.includes(log.id)} onChange={()=>toggleReviewSelection(log.id)} /> : '-'}</td>
                <td>{formatCustomerJoinNo(target.join_no, customersByJoinNo, target.customer_name)} {hasMinorInfo(log) && <span className="minorBadge">미성년자</span>}</td>
                <td>{target.assigned_employee}</td>
                <td>{target.assigned_store}</td>
                <td>{log.call_result} / {log.call_detail}</td>
                <td>{log.memo ? '있음' : '-'}</td>
                <td>{log.review_status || '검수대기'}</td>
                <td>{formatKST(log.checked_at)}</td>
                <td>{effectiveTargetDate(target)}</td>
              </tr>
            ))}
            {!loading && !reviewRows.length && <tr><td colSpan="9"><EmptyStateText>조건에 맞는 검수 건이 없습니다.</EmptyStateText></td></tr>}
          </tbody>
        </table>
        <PaginationBar total={reviewRows.length} page={page} onPageChange={setPage} pageSize={pageSize} />
      </div>

      {selected && <ReviewModal item={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} />}
      </>)}
    </div>
  );
}

function ReviewModal({ item, user, onClose, onSaved }) {
  const { log, target, allLogs = [] } = item;
  const [memo, setMemo] = useState(log.review_memo || '');
  const [busy, setBusy] = useState(false);
  useModalBodyScrollLock();

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
    <div className="modalBg reviewModalBg">
      <div className="modal reviewDetailModal">
        <div className="modalHead">
          <h2>검수 상세</h2>
          <button onClick={onClose}>닫기</button>
        </div>
        <div className="reviewDetailBody">

        <section>
          <h3>기본정보</h3>
          <div className="infoGrid">
            <p><b>가입번호</b><br />{target.customer_name ? `${target.customer_name} (${target.join_no})` : target.join_no}</p>
            {hasMinorInfo(log) && <p><b>미성년자</b><br /><span className="minorBadge">미성년자</span></p>}
            {hasMinorInfo(log) && <p><b>법정대리인 가입번호</b><br />{log.legal_rep_join_no || '미입력'}</p>}
            {hasMinorInfo(log) && <p><b>미성년자 생년월일</b><br />{log.minor_birth_date || '미입력'}</p>}
            <p><b>담당자</b><br />{target.assigned_employee}</p>
            <p><b>매장</b><br />{target.assigned_store}</p>
            <p><b>대상일</b><br />{effectiveTargetDate(target)}</p>
            <p><b>완료일시</b><br />{formatKST(log.checked_at)}</p>
            <p><b>검수일시</b><br />{log.reviewed_at ? formatKST(log.reviewed_at) : '-'}</p>
          </div>
        </section>

        <section>
          <h3>직원 입력 결과</h3>
          <p><b>{log.call_result}</b> / {log.call_detail}</p>
          <p className="reason">{log.memo || '메모 없음'}</p>
          {hasMinorInfo(log) && (
            <div className="minorReviewInfoBox">
              <h4>미성년자 정보</h4>
              <p><b>법정대리인 가입번호</b> {log.legal_rep_join_no || '미입력'}</p>
              <p><b>미성년자 생년월일</b> {log.minor_birth_date || '미입력'}</p>
            </div>
          )}
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

  const isActive = e => isHappycallAssignableEmployee(e);
  const findEmp = name => {
    const matches = (employees || []).filter(e => normName(e.name) === normName(name));
    return matches.find(isActive) || matches.find(e => e.status === '재직') || matches[0];
  };

  const baseStore = normStore(customer.store_name || customer.raw_store_name);
  const storeRow = (stores || []).find(s => normStore(s.name) === baseStore);
  let assignStore = baseStore === '지축'
    ? '지축'
    : (storeRow?.status === '폐점' && storeRow?.successor_store ? normStore(storeRow.successor_store) : baseStore);

  if (assignStore === '합정') assignStore = '능곡';
  if (assignStore === '고양') assignStore = '화정';

  const prev = (histories || [])
    .filter(h => String(h.join_no) === String(customer.join_no))
    .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))[0];

  const latestEmp = findEmp(customer.seller_name);
  if (isActive(latestEmp)) {
    return { assigned_employee: latestEmp.name, assigned_store: latestEmp.store_name || assignStore, reason: '최신/재입사 담당자 본인 재배정' };
  }

  const jichukAssignment = resolveJichukRetiredSellerRule({
    customerStore: baseStore,
    sellerName: customer.seller_name,
    employees
  });
  if (jichukAssignment) {
    return {
      ...jichukAssignment,
      assigned_employee: jichukAssignment.assigned_employee || '배정불가'
    };
  }

  const customerHistory = (customers || [])
    .filter(c => String(c.join_no) === String(customer.join_no))
    .sort((a, b) => String(b.open_date || '').localeCompare(String(a.open_date || '')));

  for (const past of customerHistory) {
    const pastEmp = findEmp(past.seller_name);
    if (isActive(pastEmp)) {
      return { assigned_employee: pastEmp.name, assigned_store: pastEmp.store_name || assignStore, reason: '과거 담당자 재입사/재직 본인 재배정' };
    }
  }

  const prevEmp = findEmp(prev?.assigned_employee);
  if (isActive(prevEmp)) {
    return { assigned_employee: prevEmp.name, assigned_store: prevEmp.store_name || assignStore, reason: '이전 배정자 유지' };
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



function displayStoreNameForUi(name) {
  return name === '관리자' ? '사무실' : (name || '');
}

function normalizeOfficeStoreName(name) {
  return name === '관리자' ? '사무실' : (name || '');
}

function sortStoresForEmployeeDropdown(stores = []) {
  const normalized = (stores || [])
    .filter(s => s && s.name)
    .filter(s => s.name !== '관리자' && s.name !== '임지하')
    .map(s => ({ ...s, name: normalizeOfficeStoreName(s.name), displayName: displayStoreNameForUi(s.name) }));

  if (!normalized.some(s => s.name === '사무실')) {
    normalized.unshift({ id: 'office-option', name: '사무실', displayName: '사무실', status: '관리용' });
  }

  return normalized.sort((a,b) => {
    const ap = a.status === '폐점' ? 1 : 0;
    const bp = b.status === '폐점' ? 1 : 0;
    if (ap !== bp) return ap - bp;
    if (a.name === '사무실') return -1;
    if (b.name === '사무실') return 1;
    return String(a.name).localeCompare(String(b.name), 'ko');
  });
}

function isHappycallAssignableEmployee(emp) {
  return !!emp && emp.status === '재직' && emp.happycall_assignment_enabled !== false;
}

function employeeAssignmentEnabledValue(emp) {
  return emp?.happycall_assignment_enabled !== false;
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

const HAPPY_CALL_EXCLUDED_STORES = new Set(['사무실', '에스플러스', '퍼스트', '주주백석', '에스플러스(이성범)']);

function isHappycallExcludedStore(storeName) {
  const normalized = String(storeName || '').replace(/\s+/g, '').trim();
  return HAPPY_CALL_EXCLUDED_STORES.has(normalized);
}

function isVisibleHappycallTarget(target) {
  return !!target && !target.is_skipped && !isHappycallExcludedStore(target.assigned_store);
}

function isHappycallExcludedCustomer(customer = {}) {
  return isHappycallExcludedStore(customer.store_name) ||
    isHappycallExcludedStore(customer.raw_store_name);
}

function isD95D185Type(callType) {
  return ['D_PLUS_93', 'D_PLUS_183', 'D_PLUS_95', 'D_PLUS_185'].includes(callType);
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
    isHappycallAssignableEmployee(e) &&
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

  const matchingSellers = (employees || []).filter(e => e.name === sellerName);
  const seller = matchingSellers.find(isActiveEmployee) || matchingSellers[0];
  if (isActiveEmployee(seller)) {
    return {
      assigned_store: normalizeStoreNameForAssignment(seller.store_name || storeName),
      assigned_employee: seller.name,
      reason: 'D+93/D+183 재직 판매자 본인 배정'
    };
  }


  const jichukAssignment = resolveJichukRetiredSellerRule({
    customerStore: storeName,
    sellerName,
    employees
  });
  if (jichukAssignment) return jichukAssignment;

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
      reason: 'D+93/D+183 퇴사자건 / 개통일 당시 점장 배정'
    };
  }

  const currentManager = findCurrentStoreManager(employees, storeName);
  if (currentManager) {
    return {
      assigned_store: normalizeStoreNameForAssignment(currentManager.store_name || storeName),
      assigned_employee: currentManager.name,
      reason: 'D+93/D+183 퇴사자건 / 현재 매장 점장 배정'
    };
  }

  return {
    assigned_store: storeName,
    assigned_employee: '',
    reason: 'D+93/D+183 퇴사자건 / 배정 가능한 점장 없음'
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
  return !!(row.is_minor || row.minor_birth_date || row.legal_rep_join_no || row.call_detail === '미성년자');
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
    'D_PLUS_93': 4,
    'D_PLUS_183': 5,
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

  function addDays(dateText, days) {
    return addDaysText(dateText, days);
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
    if (normalizeStore(storeName) === '지축') return '지축';
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
        fetchAllRows('customers', CUSTOMER_DISPLAY_COLUMNS, 'open_date'),
        fetchAllRows('employees', 'id,name,store_name,status,role,hire_date,resign_date,happycall_enabled,happycall_assignment_enabled', 'name'),
        fetchAllRows('stores', 'id,name,status,successor_store', 'name'),
        fetchAllRows('assignment_history', 'id,join_no,assigned_store,assigned_employee,assign_reason,updated_at', 'updated_at'),
        fetchAllRows('employee_store_history', 'id,employee_id,employee_name,store_name,role,start_date,end_date', 'start_date'),
        fetchAllRows('refused_customers', 'id,join_no,refused_at', 'refused_at')
      ]);
      const happycallLogs = await fetchRowsByValues(
        'happycall_logs',
        'join_no',
        (refusedRows || []).map(r => r.join_no),
        'join_no,call_result,call_detail,checked_at,review_status'
      );

      const activeEmployees = (employees || []).filter(e => isHappycallAssignableEmployee(e));
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
      const latestUnavailableByJoinNo = {};
      (happycallLogs || []).forEach(log => {
        if (!log.join_no || log.call_result !== '통화 불가' || log.review_status === '반려') return;
        const previous = latestUnavailableByJoinNo[log.join_no];
        if (!previous || String(log.checked_at || '').localeCompare(String(previous.checked_at || '')) > 0) {
          latestUnavailableByJoinNo[log.join_no] = log;
        }
      });
      const refusedDetailMap = Object.fromEntries(
        Object.entries(latestUnavailableByJoinNo).map(([joinNo, log]) => [joinNo, log.call_detail])
      );

      const plusMap = [
        { days: 1, type: 'D_PLUS_1' },
        { days: 7, type: 'D_PLUS_7' },
        { days: 13, type: 'D_PLUS_13' },
        { days: 93, type: 'D_PLUS_93' },
        { days: 183, type: 'D_PLUS_183' }
      ];

      const targetMonthText = targetMonth(targetDate);
      const targetDay = dayOfMonth(targetDate);

      const rows = [];
      const dPlusJoinNosThisMonth = new Set();

      (customers || []).forEach(c => {
        if (!c.open_date || !c.join_no) return;
        if (isHappycallExcludedCustomer(c)) return;
        plusMap.forEach(p => {
          if (shouldSkipByRefusedCustomer(c, refusedMap, p.type, refusedDetailMap)) return;
          const plusDate = addDays(c.open_date, p.days);
          const isSaturdayD1MondayCorrection = p.days === 1 && isMondayLocal(targetDate) && isSaturdayLocal(c.open_date) && addDays(c.open_date, 2) === targetDate;
          if (targetMonth(plusDate) === targetMonthText || isSaturdayD1MondayCorrection) {
            dPlusJoinNosThisMonth.add(c.join_no);
          }
          if (plusDate === targetDate || isSaturdayD1MondayCorrection) {
            const a = isD95D185Type(p.type)
              ? resolveD95D185Assignee({ customer: c, employees: employees || [], employeeHistories: employeeHistories || [] })
              : decideAssignment(c, employees || [], stores || [], historyMap, staffByStore, {});
            if (isHappycallExcludedStore(a.assigned_store)) return;
            rows.push({
              join_no: c.join_no,
              customer_name: c.customer_name,
              customer_id: c.id,
              target_date: targetDate,
              original_target_date: targetDate,
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
        if (isHappycallExcludedCustomer(c)) return;
        if (shouldSkipByRefusedCustomer(c, refusedMap, 'MONTHLY_DAY', refusedDetailMap)) return;
        if (dayOfMonth(c.open_date) !== targetDay) return;
        if (!isSameOddEvenMonth(c.open_date, targetDate)) return;
        if (dPlusJoinNosThisMonth.has(c.join_no)) return;

        const a = decideAssignment(c, employees || [], stores || [], historyMap, staffByStore, counter);
        if (isHappycallExcludedStore(a.assigned_store)) return;
        rows.push({
          join_no: c.join_no,
          customer_name: c.customer_name,
          customer_id: c.id,
          target_date: targetDate,
          original_target_date: targetDate,
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
        let rowsToInsert = chunk;
        let { error } = await supabase.from('happycall_targets').insert(rowsToInsert);

        if (error?.code === '23505') {
          const { data: refreshedRows, error: refreshError } = await supabase
            .from('happycall_targets')
            .select('join_no, target_date, is_skipped')
            .eq('target_date', targetDate);

          if (refreshError) throw refreshError;

          const refreshedKeys = new Set(
            (refreshedRows || [])
              .filter(r => r.is_skipped !== true)
              .map(r => `${r.join_no}|${r.target_date}`)
          );
          rowsToInsert = rowsToInsert.filter(r => !refreshedKeys.has(`${r.join_no}|${r.target_date}`));

          if (rowsToInsert.length) {
            ({ error } = await supabase.from('happycall_targets').insert(rowsToInsert));
          } else {
            error = null;
          }
        }

        if (error) throw error;
        saved += rowsToInsert.length;
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
        <p className="muted">대상일 기준으로 D+1, D+7, D+13, D+93, D+183과 월간 정기 해피콜을 생성합니다.</p>
        <p className="muted">D+93/D+183은 판매자 재직 시 본인 배정, 판매자 퇴사 시 근무이력 기준 당시 점장 또는 현재 매장 점장에게 배정됩니다.</p>
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
                  <td>{currentHappycallTerm(r.skip_reason)}</td>
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
  const [loading, setLoading] = useState(true);
  useEffect(() => { load(); }, []);
  async function load() {
    try {
      const { data: allTargets } = await runNetworkRead(() => supabase
        .from('happycall_targets')
        .select(HAPPY_CALL_TARGET_LIST_COLUMNS)
        .eq('assigned_store', user.store_name)
        .order('target_date', { ascending: true }));
      const visible = (allTargets || []).filter(t => isVisibleHappycallTarget(t) && t.assigned_store === user.store_name);
      const allLogs = await fetchRowsByValues('happycall_logs', 'target_id', visible.map(t => t.id), HAPPY_CALL_LOG_LIST_COLUMNS);
      setTargets(visible);
      setLogs(allLogs || []);
    } catch (e) {
      alert('매장 현황 조회 오류: ' + e.message);
    } finally {
      setLoading(false);
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
      {loading ? (
        <div className="sectionCard pageLoadingPanel"><InlineLoadingState /></div>
      ) : (<>
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
        <tbody>{targets.map(t => { const log = latestLogByTarget[t.id]; return <tr key={t.id} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })} className="clickableRow"><td>{t.join_no}</td><td>{t.assigned_employee}</td><td>{callTypeLabel(t.call_type)}</td><td>{effectiveTargetDate(t)}</td><td>{isFutureScheduledTarget(t) ? '처리 예정' : log ? '완료' : '미완료'}</td><td>{log ? `${log.call_result} / ${log.call_detail}` : '-'}</td></tr> })}</tbody></table>
      </div>
      {selected && <CallModal target={selected} user={user} onClose={() => setSelected(null)} onSaved={load} readOnly={true} />}
      </>)}
    </div>
  );
}




function ManagerStoreDashboardV6({ user }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('미완료전체');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const { data: allTargets } = await runNetworkRead(() => supabase
        .from('happycall_targets')
        .select(HAPPY_CALL_TARGET_LIST_COLUMNS)
        .eq('assigned_store', user.store_name)
        .order('target_date', { ascending: true }));
      const visible = (allTargets || []).filter(t => isVisibleHappycallTarget(t) && t.assigned_store === user.store_name);
      const allLogs = await fetchRowsByValues('happycall_logs', 'target_id', visible.map(t => t.id), HAPPY_CALL_LOG_LIST_COLUMNS);
      setTargets(visible);
      setLogs(allLogs || []);
    } catch (e) {
      alert('매장 현황 조회 오류: ' + e.message);
    } finally {
      setLoading(false);
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
      const log = latestLogByTarget[t.id];
      if (!log && effectiveTargetDate(t) > todayLocalISO()) return;
      const k = t.assigned_employee || '미지정';
      if (!map[k]) map[k] = { name:k,total:0,done:0,todayTotal:0,todayDone:0,overdue:0,voc:0 };
      map[k].total++;
      if (log) map[k].done++;
      if (effectiveTargetDate(t) === todayLocalISO()) {
        map[k].todayTotal++;
        if (log) map[k].todayDone++;
      }
      if (!log && diffDays(effectiveTargetDate(t)) > 0) map[k].overdue++;
      if (log?.call_detail === '불만사항있음') map[k].voc++;
    });
    return Object.values(map).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko'));
  }, [targets, latestLogByTarget]);

  const filteredTargets = useMemo(() => {
    let list = [...targets];
    if (filter === '경과미완료') list = list.filter(t => !latestLogByTarget[t.id] && diffDays(effectiveTargetDate(t)) > 0);
    else if (filter === '오늘신규') list = list.filter(t => effectiveTargetDate(t) === todayLocalISO());
    else if (filter === '미완료전체') list = list.filter(t => !latestLogByTarget[t.id] && effectiveTargetDate(t) <= todayLocalISO());
    else if (filter === '완료') list = list.filter(t => latestLogByTarget[t.id]);
    return list.sort((a,b)=>sortTargetsByPriority(a,b,latestLogByTarget));
  }, [targets, latestLogByTarget, filter]);

  return (
    <div>
      <h2>{user.store_name} 해피콜 현황</h2>
      {loading ? (
        <div className="sectionCard pageLoadingPanel"><InlineLoadingState /></div>
      ) : (<>
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
            {!loading && !filtered.length && <tr><td colSpan="9" className="muted">로그가 없습니다.</td></tr>}
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
          <button className={filter==='전체'?'active':''} onClick={()=>setFilter('전체')}>전체 {stats.allTotal}</button>
        </div>
        <table>
          <thead><tr><th>가입번호</th><th>담당자</th><th>유형</th><th>대상일</th><th>상태</th><th>결과</th></tr></thead>
          <tbody>
            {filteredTargets.map(t => {
              const log = latestLogByTarget[t.id];
              return (
                <tr key={t.id} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })} className="clickableRow">
                  <td>{t.join_no}</td><td>{t.assigned_employee}</td><td>{callTypeLabel(t.call_type)}</td><td>{effectiveTargetDate(t)}</td>
                  <td><StatusBadge target={t} log={log} /></td>
                  <td>{log ? `${log.call_result} / ${log.call_detail}` : '-'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {selected && <CallModal target={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} readOnly={true} />}
      </>)}
    </div>
  );
}
