Exit code: 0
Wall time: 0.9 seconds
Total output lines: 8564
Output:
import React, { Component, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import './styles.css';
import {
  createClientUuid,
  runNetworkMutation,
  runNetworkRead
} from './networkMutation.js';
import { createAsyncQueryCache } from './asyncQueryCache.js';
import { loadPagedRows } from './pagedRows.js';
import {
  accrualHistoryRows,
  findHolidayAccrualDraft,
  holidayAccrualStep,
  normalizeAccrualTypeValue
} from './accrualFlow.js';
import {
  resolveJichukRetiredSellerRule
} from './stage1Rules.js';
import {
  isAdminLikeRole,
  isSuperAdminRole,
  PASSWORD_POLICY_MESSAGE,
  requiresPasswordChange,
  validatePasswordPolicy
} from './authSecurity.js';
import {
  changeAuthenticatedPassword,
  completeLegacyPasswordMigration,
  loadActiveLoginDirectory,
  loadAuthenticatedEmployee,
  resetEmployeeTemporaryPassword,
  signInEmployee
} from './authClient.js';
import {
  freepassBulkEmployeeKey,
  prepareFreepassBulkAdjustment
} from './freepassBulkAdjustment.js';
import AttendanceModule, { FeatureAccessManager } from './AttendanceModule.jsx';
import {
  featureKeyForTab,
  resolveAllFeatureAccess
} from './featureAccess.js';

const APP_BUILD_VERSION = 'V29.64';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '');

const REMEMBER_LOGIN_KEY = 'sechan_remember_login_v1';
const LOGIN_POLICY_READY_KEY = 'sechan_login_policy_ready_v1';
const TAB_LOGIN_KEY = 'sechan_tab_login_v1';
const PENDING_LOGIN_KEY = 'sechan_pending_login_v1';
const REMEMBER_LOGIN_MS = 7 * 24 * 60 * 60 * 1000;

function readRememberedLogin(authUserId = '') {
  try {
    const saved = JSON.parse(localStorage.getItem(REMEMBER_LOGIN_KEY) || 'null');
    const valid = saved?.auth_user_id && saved.auth_user_id === authUserId && Number(saved.expires_at) > Date.now();
    if (!valid && saved) localStorage.removeItem(REMEMBER_LOGIN_KEY);
    return valid ? saved : null;
  } catch {
    try { localStorage.removeItem(REMEMBER_LOGIN_KEY); } catch {}
    return null;
  }
}

function markLoginPreference(authUserId, remember) {
  try {
    localStorage.setItem(LOGIN_POLICY_READY_KEY, '1');
    if (remember) {
      localStorage.setItem(REMEMBER_LOGIN_KEY, JSON.stringify({
        auth_user_id: authUserId,
        expires_at: Date.now() + REMEMBER_LOGIN_MS
      }));
      sessionStorage.removeItem(TAB_LOGIN_KEY);
    } else {
      localStorage.removeItem(REMEMBER_LOGIN_KEY);
      sessionStorage.setItem(TAB_LOGIN_KEY, authUserId);
    }
  } catch {}
}

function clearLoginPreference() {
  try { localStorage.removeItem(REMEMBER_LOGIN_KEY); } catch {}
  try { sessionStorage.removeItem(TAB_LOGIN_KEY); } catch {}
  try { sessionStorage.removeItem(PENDING_LOGIN_KEY); } catch {}
}

function isLoginAllowedInThisBrowser(authUserId) {
  if (readRememberedLogin(authUserId)) return true;
  try {
    const pending = sessionStorage.getItem(PENDING_LOGIN_KEY);
    if (pending === 'remember' || pending === 'session') {
      sessionStorage.removeItem(PENDING_LOGIN_KEY);
      markLoginPreference(authUserId, pending === 'remember');
      return true;
    }
    if (sessionStorage.getItem(TAB_LOGIN_KEY) === authUserId) return true;
    if (!localStorage.getItem(LOGIN_POLICY_READY_KEY)) {
      localStorage.setItem(LOGIN_POLICY_READY_KEY, '1');
      sessionStorage.setItem(TAB_LOGIN_KEY, authUserId);
      return true;
    }
  } catch {}
  return false;
}

const pendingErrorReportKeys = new Set();

const happycallFullQueryCache = createAsyncQueryCache({ ttlMs: 60000 });
const HAPPYCALL_CACHE_TABLES = new Set(['happycall_targets', 'happycall_logs', 'customers']);
let happycallCacheAuthScope = 'anonymous';

function invalidateHappycallDataCache(tableNames = null) {
  if (!tableNames?.length) {
    happycallFullQueryCache.clear();
    return;
  }
  const tables = new Set(tableNames);
  happycallFullQueryCache.deleteWhere(key => {
    const [, tableName] = String(key).split('|');
    return tables.has(tableName);
  });
}

supabase.auth.onAuthStateChange((_event, session) => {
  const nextScope = session?.user?.id || 'anonymous';
  if (nextScope !== happycallCacheAuthScope) invalidateHappycallDataCache();
  happycallCacheAuthScope = nextScope;
});

async function fetchAllRowsUncached(tableName, selectText = '*', orderColumn = null) {
  const pageSize = 1000;
  return loadPagedRows({
    pageSize,
    concurrency: 4,
    loadPage: (from, to, { includeCount }) => runNetworkRead(() => {
      let query = supabase
        .from(tableName)
        .select(selectText, includeCount ? { count: 'exact' } : undefined)
        .range(from, to);
      if (orderColumn) query = query.order(orderColumn, { ascending: true });
      return query;
    })
  });
}

async function fetchAllRows(tableName, selectText = '*', orderColumn = null) {
  if (!HAPPYCALL_CACHE_TABLES.has(tableName)) {
    return fetchAllRowsUncached(tableName, selectText, orderColumn);
  }

  const cacheKey = [happycallCacheAuthScope, tableName, selectText, orderColumn || ''].join('|');
  return happycallFullQueryCache.getOrLoad(
    cacheKey,
    () => fetchAllRowsUncached(tableName, selectText, orderColumn)
  );
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
const EMPLOYEE_LIST_COLUMNS = 'id,name,store_name,status,created_at,role,hire_date,resign_date,happycall_enabled,happycall_assignment_enabled,end_time,password_change_required,password_changed_at,auth_user_id';
const REFUSED_CUSTOMER_LIST_COLUMNS = 'id,join_no,target_id,refused_by,refused_at,memo,customer_name,is_minor,minor_birth_date';
const FREEPASS_LEDGER_LIST_COLUMNS = 'id,employee_id,employee_name,employee_store,type,hours,reason,effective_date,created_by,created_at,source_request_id,reset_cycle';
const FREEPASS_REQUEST_LOG_COLUMNS = 'id,employee_name,employee_store,request_type,request_date,hours,reason,status,requested_at,created_at,manager_approved_by,final_approved_by';
const FREEPASS_REQUEST_LIST_COLUMNS = [
  'id','employee_id','employee_name','employee_store','request_type','use_type','request_date','use_start_time',
  'hours','reason','evidence_deleted_at','status','manager_status','manager_approved_by','manager_approved_at',
  'manager_rejected_by','manager_rejected_at','final_status','final_approved_by','final_approved_at',
  'final_rejected_by','final_rejected_at','reject_reason','requested_at','created_at','reset_cycle',
  'consent_agreed','consent_agreed_at','consent_text','consent_snapshot'
].join(',');

async function loadFreepassRequestEvidence(row) {
  if (!row?.id || row.evidence_deleted_at || row.evidence_photo_data !== undefined) return row;
  const { data, error } = await runNetworkRead(() => supabase
    .from('freepass_requests')
    .select('id,evidence_photo_data,evidence_deleted_at')
    .eq('id', row.id)
    .maybeSingle());
  if (error) throw error;
  return { ...row, ...(data || {}), evidence_photo_data: data?.evidence_photo_data || null };
}


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
  const [user, setUser] = useState(null);
  const [sessionChecking, setSessionChecking] = useState(true);
  const invalidSessionNotified = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function syncAuthenticatedEmployee({ notifyInvalid = false } = {}) {
      try {
        const { data: { session }, error: sessionError } = await supabase.auth.getSession();
        if (sessionError) throw sessionError;
        if (!session?.user?.id) {
          if (!cancelled) {
            setUser(null);
            setSessionChecking(false);
          }
          return;
        }

        if (!isLoginAllowedInThisBrowser(session.user.id)) {
          await supabase.auth.signOut({ scope: 'local' });
          if (!cancelled) {
            setUser(null);
            setSessionChecking(false);
          }
          return;
        }

        const employee = await loadAuthenticatedEmployee(supabase, session.user.id);
        if (cancelled) return;
        if (!employee) {
          clearLoginPreference();
          await supabase.auth.signOut({ scope: 'local' });
          setUser(null);
          if (notifyInvalid && !invalidSessionNotified.current) {
            invalidSessionNotified.current = true;
            alert('퇴사 처리되었거나 접속 권한이 없어 로그아웃되었습니다.');
          }
        } else {
          invalidSessionNotified.current = false;
          setUser(employee);
        }
      } catch (error) {
        console.warn('employee auth session validation failed', error);
      } finally {
        if (!cancelled) setSessionChecking(false);
      }
    }

    syncAuthenticatedEmployee();
    const { data: authListener } = supabase.auth.onAuthStateChange(() => {
      window.setTimeout(() => syncAuthenticatedEmployee(), 0);
    });
    const handleFocus = () => syncAuthenticatedEmployee({ notifyInvalid: true });
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') syncAuthenticatedEmployee({ notifyInvalid: true });
    };
    const intervalId = window.setInterval(() => syncAuthenticatedEmployee({ notifyInvalid: true }), 30 * 1000);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      cancelled = true;
      authListener?.subscription?.unsubscribe();
      window.clearInterval(intervalId);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, []);

  async function refreshAuthenticatedUser({ remember = null } = {}) {
    const { data: { user: authUser } } = await supabase.auth.getUser();
    if (!authUser) {
      setUser(null);
      return;
    }
    if (remember !== null) markLoginPreference(authUser.id, remember);
    const employee = await loadAuthenticatedEmployee(supabase, authUser.id);
    setUser(employee);
  }

  if (!supabaseUrl || !supabaseAnonKey) return <EnvMissing />;
  if (sessionChecking) return <div className="page center"><div className="loginCard"><InlineLoadingState label="접속 권한 확인 중" /></div></div>;
  if (!user) return <Login onAuthenticated={refreshAuthenticatedUser} />;
  if (requiresPasswordChange(user)) {
    return <PasswordChangeModal user={user} forced onUserUpdate={refreshAuthenticatedUser} />;
  }

  return (
    <ErrorBoundary>
      <MainApp
        user={user}
        onUserUpdate={refreshAuthenticatedUser}
        onLogout={async () => {
          clearLoginPreference();
          await supabase.auth.signOut({ scope: 'local' });
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


const LOGIN_STORE_ORDER = ['금촌', '야당', …93011 tokens truncated…        const { data: refreshedRows, error: refreshError } = await supabase
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
      invalidateHappycallDataCache(['happycall_targets']);
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
      invalidateHappycallDataCache(['happycall_targets']);
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
          <input className="uiDateTimeInput" type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
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
        <table className="managerDesktopTable">
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
            {!byEmployee.length && <tr><td colSpan="8" className="muted">표시할 직원 현황이 없습니다.</td></tr>}
          </tbody>
        </table>
        <div className="mobileCardList managerEmployeeMobileList">
          {byEmployee.map(r => {
            const totalRate = r.total ? Math.round(r.done/r.total*1000)/10 : 0;
            const todayRate = r.todayTotal ? Math.round(r.todayDone/r.todayTotal*1000)/10 : 0;
            return <MobileInfoCard key={r.name} title={r.name} subtitle={`전체 ${r.done}/${r.total} · 오늘 ${r.todayDone}/${r.todayTotal}`} meta={[`전체 완료율 ${totalRate}%`, `오늘 완료율 ${todayRate}%`, `경과 미완료 ${r.overdue}`, `VOC ${r.voc}`]} status={`${totalRate}%`} badgeClass={totalRate < 100 ? 'waiting' : 'approved'} />;
          })}
          {!byEmployee.length && <EmptyStateText>표시할 직원 현황이 없습니다.</EmptyStateText>}
        </div>
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
        <table className="managerDesktopTable">
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
        <div className="mobileCardList managerCallsMobileList">
          {filteredTargets.map(t => {
            const log = latestLogByTarget[t.id];
            return (
              <MobileInfoCard key={t.id} title={t.join_no} subtitle={`${t.assigned_employee} · ${callTypeLabel(t.call_type)}`} meta={[`대상일 ${effectiveTargetDate(t)}`, log ? `${log.call_result} / ${log.call_detail}` : '처리 결과 없음']} status={log ? '완료' : '미완료'} badgeClass={log ? 'approved' : 'waiting'} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })} />
            );
          })}
          {!filteredTargets.length && <EmptyStateText>표시할 해피콜이 없습니다.</EmptyStateText>}
        </div>
      </div>
      {selected && <CallModal target={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} readOnly={true} />}
      </>)}
    </div>
  );
}

