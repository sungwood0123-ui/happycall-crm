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

const APP_BUILD_VERSION = 'V29.65';

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
  '?듯솕 ?꾨즺': ['遺덈쭔?ы빆?놁쓬', '遺덈쭔?ы빆?덉쓬'],
  '遺?ъ쨷': ['移댁뭅?ㅽ넚諛쒖넚', '臾몄옄諛쒖넚'],
  '?듯솕 遺덇?': ['2nd?붾컮?댁뒪', '???蹂寃?, '?듭떊???대룞', '?댁?', '留덉???誘몃룞??, '怨좉컼?ъ젙', '?ш퀬 諛쒖깮嫄?]
};

const D95_D185_RECHECK_UNAVAILABLE_DETAILS = new Set(['怨좉컼?ъ젙', '留덉???誘몃룞??, '?ш퀬 諛쒖깮嫄?]);

function isUnavailableCall(result) {
  return result === '?듯솕 遺덇?';
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
            <h1>?붾㈃ ?ㅻ쪟</h1>
            <p className="error">{this.state.error.message}</p>
            <p className="muted">?붾㈃???덈줈怨좎묠?섍굅??愿由ъ옄?먭쾶 ??硫붿떆吏瑜??꾨떖?댁＜?몄슂.</p>
            <button className="primary" onClick={() => location.reload()}>?덈줈怨좎묠</button>
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
            alert('?댁궗 泥섎━?섏뿀嫄곕굹 ?묒냽 沅뚰븳???놁뼱 濡쒓렇?꾩썐?섏뿀?듬땲??');
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
  if (sessionChecking) return <div className="page center"><div className="loginCard"><InlineLoadingState label="?묒냽 沅뚰븳 ?뺤씤 以? /></div></div>;
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
        <img className="loginLogo" src="./sechan-logo.png" alt="?몄갔而댄띁??濡쒓퀬" onError={e=>{e.currentTarget.style.display='none'}} />
        <h1>?몄갔而댄띁???명듃?쇰꽬</h1>
        <p className="error">Supabase ?곌껐媛믪씠 ?ㅼ젙?섏? ?딆븯?듬땲??</p>
        <p className="muted">Vercel ?섍꼍蹂?섏뿉 VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY瑜??ｌ뼱二…94878 tokens truncated…  .filter(r => r.is_skipped !== true)
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

      await writeAuditLog('?댄뵾肄쒕??곸???, 'happycall_targets', targetDate, user, `${targetDate} ?좉퇋 ${saved}嫄?/ 湲곗〈 ${summary.saveRows.length - saved}嫄?嫄대꼫?`);
      invalidateHappycallDataCache(['happycall_targets']);
      alert(`????꾨즺: ?좉퇋 ${saved}嫄?/ 湲곗〈 ${summary.saveRows.length - saved}嫄?嫄대꼫?`);
    } catch(e) {
      alert('DB ????ㅻ쪟: ' + e.message);
    } finally {
      setBusy(false);
    }
  }


  async function deleteGeneratedTargetsForDate() {
    if (user.role !== '愿由ъ옄') {
      alert('愿由ъ옄留???젣?????덉뒿?덈떎.');
      return;
    }

    const { data: existingRows, error: countError } = await supabase
      .from('happycall_targets')
      .select('id, join_no, target_date, call_type')
      .eq('target_date', targetDate);

    if (countError) {
      alert('??젣 ???議고쉶 ?ㅻ쪟: ' + countError.message);
      return;
    }

    const count = existingRows?.length || 0;
    if (!count) {
      alert(`${targetDate}????젣???댄뵾肄???곸씠 ?놁뒿?덈떎.`);
      return;
    }

    const confirmText = `${targetDate} ?댄뵾肄????${count}嫄댁쓣 ??젣?⑸땲??\n寃??泥섎━ 濡쒓렇媛 ?곌껐????곸? ??젣?섎㈃ ???????덉뒿?덈떎.\n?뺣쭚 ??젣?섎젮硫??꾨옒 ?낅젰李쎌뿉 ??젣 ?쇨퀬 ?낅젰?댁＜?몄슂.`;
    const input = prompt(confirmText);
    if (input !== '??젣') {
      alert('??젣媛 痍⑥냼?섏뿀?듬땲??');
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
        alert('?대? 泥섎━/寃??濡쒓렇媛 ?곌껐????곷쭔 ?덉뼱 ??젣?????놁뒿?덈떎.');
        return;
      }

      const { error } = await supabase
        .from('happycall_targets')
        .delete()
        .in('id', deletableIds);

      if (error) throw error;

      await writeAuditLog('?댄뵾肄쒕??곸궘??, 'happycall_targets', targetDate, user, `${targetDate} ??젣 ${deletableIds.length}嫄?/ 濡쒓렇?곌껐 ?쒖쇅 ${count - deletableIds.length}嫄?);
      invalidateHappycallDataCache(['happycall_targets']);
      alert(`??젣 ?꾨즺: ${deletableIds.length}嫄?n濡쒓렇 ?곌껐 ?쒖쇅: ${count - deletableIds.length}嫄?);
      setSummary(null);
      setPreview([]);
    } catch (e) {
      alert('?댄뵾肄??????젣 ?ㅻ쪟: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>?댄뵾肄??앹꽦</h2>
      <LastAuditNotice action="?댄뵾肄쒕??곸??? label="留덉?留??댄뵾肄??????? />
      {user.role === '愿由ъ옄' && <button className="dangerBtn" onClick={deleteGeneratedTargetsForDate} disabled={busy}>?뱀씪 ?앹꽦 ?댄뵾肄???젣</button>}
      <div className="uploadBox">
        <p className="muted">??곸씪 湲곗??쇰줈 D+1, D+7, D+13, D+93, D+183怨??붽컙 ?뺢린 ?댄뵾肄쒖쓣 ?앹꽦?⑸땲??</p>
        <p className="muted">D+93/D+183? ?먮ℓ???ъ쭅 ??蹂몄씤 諛곗젙, ?먮ℓ???댁궗 ??洹쇰Т?대젰 湲곗? ?뱀떆 ?먯옣 ?먮뒗 ?꾩옱 留ㅼ옣 ?먯옣?먭쾶 諛곗젙?⑸땲??</p>
        <p className="muted">?뱀썡 D+ ?댄뵾肄쒖씠 ?덈뒗 怨좉컼? ?대떦 ?붿쓽 ?붽컙 ?뺢린 ?댄뵾肄쒖뿉???쒖쇅?⑸땲??</p>
        <p className="muted">???뺢린 ?댄뵾肄쒖? ??섎떖 媛쒗넻 怨좉컼? ??섎떖, 吏앹닔??媛쒗넻 怨좉컼? 吏앹닔?ъ뿉留??앹꽦?⑸땲??</p>
        <p className="muted">?쇱슂???먮룞 ?앹꽦? ?쒕쾭 ?ㅼ?以꾨윭媛 KST ?ㅼ쟾 9?쒖뿉 ?ㅽ뻾?섎ŉ, ?좎슂??媛쒗넻 D+1? ?붿슂???앹꽦 ???먮룞 蹂댁젙?⑸땲??</p>
        <p className="muted">?듯솕 遺덇? 怨좉컼? ?댄썑 ?댄뵾肄??앹꽦 ??곸뿉???쒖쇅?⑸땲??</p>

        <div className="formGrid compact">
          <input className="uiDateTimeInput" type="date" value={targetDate} onChange={e => setTargetDate(e.target.value)} />
          <button className="primary" onClick={generateTargets} disabled={busy}>???怨꾩궛</button>
          {summary && <button className="primary" onClick={saveTargets} disabled={busy}>?댄뵾肄????DB ???/button>}
        </div>

        {busy && <p className="muted">泥섎━ 以?..</p>}

        {summary && (
          <div className="summaryGrid">
            <Card title="?꾩껜 怨좉컼" value={summary.customerCount} />
            <Card title="?앹꽦 ??? value={summary.generated} />
            <Card title="???媛?? value={summary.savable} />
            <Card title="諛곗젙遺덇?" value={summary.unassigned} />
          </div>
        )}
      </div>

      {preview.length > 0 && (
        <div>
          <h3>誘몃━蹂닿린 理쒕? 150嫄?/h3>
          <table>
            <thead>
              <tr>
                <th>媛?낅쾲??/th>
                <th>??곸씪</th>
                <th>?좏삎</th>
                <th>諛곗젙留ㅼ옣</th>
                <th>?대떦??/th>
                <th>諛곗젙?ъ쑀</th>
              </tr>
            </thead>
            <tbody>
              {preview.map((r, i) => (
                <tr key={`${r.join_no}-${r.call_type}-${i}`}>
                  <td>{r.customer_name ? `${r.customer_name} (${r.join_no})` : r.join_no}</td>
                  <td>{r.target_date}</td>
                  <td>{callTypeLabel(r.call_type)}</td>
                  <td>{r.assigned_store}</td>
                  <td>{r.assigned_employee || '諛곗젙遺덇?'}</td>
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
      alert('留ㅼ옣 ?꾪솴 議고쉶 ?ㅻ쪟: ' + e.message);
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
    const voc = targets.filter(t => latestLogByTarget[t.id]?.call_detail === '遺덈쭔?ы빆?덉쓬').length;
    const absent = targets.filter(t => latestLogByTarget[t.id]?.call_result === '遺?ъ쨷').length;
    const rejected = targets.filter(t => isUnavailableCall(latestLogByTarget[t.id]?.call_result, latestLogByTarget[t.id]?.call_detail)).length;
    return { total, done, pending: total - done, voc, absent, rejected, rate: total ? Math.round(done / total * 1000) / 10 : 0 };
  }, [targets, latestLogByTarget]);
  const byEmployee = useMemo(() => {
    const map = {};
    targets.forEach(t => {
      const k = t.assigned_employee || '誘몄???;
      if (!map[k]) map[k] = { name: k, total: 0, done: 0, voc: 0 };
      map[k].total++;
      const log = latestLogByTarget[t.id];
      if (log) map[k].done++;
      if (log?.call_detail === '遺덈쭔?ы빆?덉쓬') map[k].voc++;
    });
    return Object.values(map).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko'));
  }, [targets, latestLogByTarget]);
  return (
    <div>
      <h2>{user.store_name} ?댄뵾肄??꾪솴</h2>
      {loading ? (
        <div className="sectionCard pageLoadingPanel"><InlineLoadingState /></div>
      ) : (<>
      <div className="stats">
        <Card title="?꾩껜 ??? value={stats.total} />
        <Card title="?꾨즺" value={stats.done} />
        <Card title="誘몄셿猷? value={stats.pending} />
        <Card title="?꾨즺?? value={`${stats.rate}%`} />
      </div>
      <div className="stats miniStats">
        <Card title="VOC" value={stats.voc} />
        <Card title="遺?ъ쨷" value={stats.absent} />
        <Card title="?듯솕嫄곕?" value={stats.rejected} />
        <Card title="?대떦???? value={byEmployee.length} />
      </div>
      <div className="sectionCard">
        <h3>吏곸썝蹂?吏꾪뻾瑜?/h3>
        <table><thead><tr><th>?대떦??/th><th>?꾩껜</th><th>?꾨즺</th><th>誘몄셿猷?/th><th>?꾨즺??/th><th>VOC</th></tr></thead>
        <tbody>{byEmployee.map(r => <tr key={r.name}><td>{r.name}</td><td>{r.total}</td><td>{r.done}</td><td>{r.total-r.done}</td><td>{r.total ? Math.round(r.done/r.total*1000)/10 : 0}%</td><td>{r.voc}</td></tr>)}</tbody></table>
      </div>
      <div className="sectionCard">
        <h3>留ㅼ옣 ?댄뵾肄?由ъ뒪??/h3>
        <table><thead><tr><th>媛?낅쾲??/th><th>踰뺤젙?由ъ씤</th><th>?대떦??/th><th>?좏삎</th><th>??곸씪</th><th>?곹깭</th><th>寃곌낵</th></tr></thead>
        <tbody>{targets.map(t => { const log = latestLogByTarget[t.id]; return <tr key={t.id} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })} className="clickableRow"><td>{t.join_no}</td><td>{t.assigned_employee}</td><td>{callTypeLabel(t.call_type)}</td><td>{effectiveTargetDate(t)}</td><td>{isFutureScheduledTarget(t) ? '泥섎━ ?덉젙' : log ? '?꾨즺' : '誘몄셿猷?}</td><td>{log ? `${log.call_result} / ${log.call_detail}` : '-'}</td></tr> })}</tbody></table>
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
  const [filter, setFilter] = useState('誘몄셿猷뚯쟾泥?);

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
      alert('留ㅼ옣 ?꾪솴 議고쉶 ?ㅻ쪟: ' + e.message);
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
      const k = t.assigned_employee || '誘몄???;
      if (!map[k]) map[k] = { name:k,total:0,done:0,todayTotal:0,todayDone:0,overdue:0,voc:0 };
      map[k].total++;
      if (log) map[k].done++;
      if (effectiveTargetDate(t) === todayLocalISO()) {
        map[k].todayTotal++;
        if (log) map[k].todayDone++;
      }
      if (!log && diffDays(effectiveTargetDate(t)) > 0) map[k].overdue++;
      if (log?.call_detail === '遺덈쭔?ы빆?덉쓬') map[k].voc++;
    });
    return Object.values(map).sort((a,b)=>String(a.name).localeCompare(String(b.name),'ko'));
  }, [targets, latestLogByTarget]);

  const filteredTargets = useMemo(() => {
    let list = [...targets];
    if (filter === '寃쎄낵誘몄셿猷?) list = list.filter(t => !latestLogByTarget[t.id] && diffDays(effectiveTargetDate(t)) > 0);
    else if (filter === '?ㅻ뒛?좉퇋') list = list.filter(t => effectiveTargetDate(t) === todayLocalISO());
    else if (filter === '誘몄셿猷뚯쟾泥?) list = list.filter(t => !latestLogByTarget[t.id] && effectiveTargetDate(t) <= todayLocalISO());
    else if (filter === '?꾨즺') list = list.filter(t => latestLogByTarget[t.id]);
    return list.sort((a,b)=>sortTargetsByPriority(a,b,latestLogByTarget));
  }, [targets, latestLogByTarget, filter]);

  return (
    <div>
      <h2>{user.store_name} ?댄뵾肄??꾪솴</h2>
      {loading ? (
        <div className="sectionCard pageLoadingPanel"><InlineLoadingState /></div>
      ) : (<>
      <div className="stats">
        <Card title="?꾩껜 ??? value={stats.total} />
        <Card title="?꾩껜 ?꾨즺?? value={`${stats.rate}%`} />
        <Card title="?ㅻ뒛 ?묒뾽 ?꾨즺?? value={`${stats.todayRate}%`} />
        <Card title="寃쎄낵 誘몄셿猷? value={stats.overdue} />
      </div>
      <div className="stats miniStats">
        <Card title="?ㅻ뒛 ?좉퇋" value={stats.todayTotal} />
        <Card title="?ㅻ뒛 ?꾨즺" value={stats.todayDone} />
        <Card title="?꾩껜 誘몄셿猷? value={stats.pending} />
        <Card title="VOC" value={stats.voc} />
      </div>
      <div className="sectionCard">
        <h3>吏곸썝蹂?吏꾪뻾瑜?/h3>
        <table className="managerDesktopTable">
          <thead><tr><th>?대떦??/th><th>?꾩껜</th><th>?꾨즺</th><th>?꾩껜 ?꾨즺??/th><th>?ㅻ뒛 ?묒뾽</th><th>?ㅻ뒛 ?꾨즺??/th><th>寃쎄낵 誘몄셿猷?/th><th>VOC</th></tr></thead>
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
            {!byEmployee.length && <tr><td colSpan="8" className="muted">?쒖떆??吏곸썝 ?꾪솴???놁뒿?덈떎.</td></tr>}
          </tbody>
        </table>
        <div className="mobileCardList managerEmployeeMobileList">
          {byEmployee.map(r => {
            const totalRate = r.total ? Math.round(r.done/r.total*1000)/10 : 0;
            const todayRate = r.todayTotal ? Math.round(r.todayDone/r.todayTotal*1000)/10 : 0;
            return <MobileInfoCard key={r.name} title={r.name} subtitle={`?꾩껜 ${r.done}/${r.total} 쨌 ?ㅻ뒛 ${r.todayDone}/${r.todayTotal}`} meta={[`?꾩껜 ?꾨즺??${totalRate}%`, `?ㅻ뒛 ?꾨즺??${todayRate}%`, `寃쎄낵 誘몄셿猷?${r.overdue}`, `VOC ${r.voc}`]} status={`${totalRate}%`} badgeClass={totalRate < 100 ? 'waiting' : 'approved'} />;
          })}
          {!byEmployee.length && <EmptyStateText>?쒖떆??吏곸썝 ?꾪솴???놁뒿?덈떎.</EmptyStateText>}
        </div>
      </div>
      <div className="sectionCard">
        <h3>留ㅼ옣 ?댄뵾肄?由ъ뒪??/h3>
        <div className="filterBar">
          <button className={filter==='誘몄셿猷뚯쟾泥??'active':''} onClick={()=>setFilter('誘몄셿猷뚯쟾泥?)}>誘몄셿猷??꾩껜 {stats.pending}</button>
          <button className={filter==='寃쎄낵誘몄셿猷??'active':''} onClick={()=>setFilter('寃쎄낵誘몄셿猷?)}>寃쎄낵 誘몄셿猷?{stats.overdue}</button>
          <button className={filter==='?ㅻ뒛?좉퇋'?'active':''} onClick={()=>setFilter('?ㅻ뒛?좉퇋')}>?ㅻ뒛 ?좉퇋 {stats.todayTotal}</button>
          <button className={filter==='?꾨즺'?'active':''} onClick={()=>setFilter('?꾨즺')}>?꾨즺 {stats.done}</button>
          <button className={filter==='?꾩껜'?'active':''} onClick={()=>setFilter('?꾩껜')}>?꾩껜 {stats.allTotal}</button>
        </div>
        <table className="managerDesktopTable">
          <thead><tr><th>媛?낅쾲??/th><th>?대떦??/th><th>?좏삎</th><th>??곸씪</th><th>?곹깭</th><th>寃곌낵</th></tr></thead>
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
              <MobileInfoCard key={t.id} title={t.join_no} subtitle={`${t.assigned_employee} 쨌 ${callTypeLabel(t.call_type)}`} meta={[`??곸씪 ${effectiveTargetDate(t)}`, log ? `${log.call_result} / ${log.call_detail}` : '泥섎━ 寃곌낵 ?놁쓬']} status={log ? '?꾨즺' : '誘몄셿猷?} badgeClass={log ? 'approved' : 'waiting'} onClick={()=>setSelected({ ...t, latestLog: latestLogByTarget[t.id] || null })} />
            );
          })}
          {!filteredTargets.length && <EmptyStateText>?쒖떆???댄뵾肄쒖씠 ?놁뒿?덈떎.</EmptyStateText>}
        </div>
      </div>
      {selected && <CallModal target={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} readOnly={true} />}
      </>)}
    </div>
  );
}

