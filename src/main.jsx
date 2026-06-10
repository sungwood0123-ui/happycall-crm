import React, { Component, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import './styles.css';

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
  '통화완료': ['불만사항없음', '불만사항있음'],
  '부재중': ['카카오톡발송', '문자발송'],
  '통화거부': ['통화거부']
};

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

function Login({ onLogin }) {
  const [employees, setEmployees] = useState([]);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { loadEmployees(); }, []);

  async function loadEmployees() {
    const { data, error } = await supabase.from('employees').select('*').eq('status', '재직').order('name');
    if (error) setErr(error.message);
    setEmployees(data || []);
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

function MainApp({ user, onLogout, onUserUpdate }) {
  const [tab, setTab] = useState('mycalls');
  const [showPassword, setShowPassword] = useState(false);
  const [openMenu, setOpenMenu] = useState('');
  const isAdmin = user.role === '관리자';
  const isManager = user.role === '점장';
  const isChecker = user.role === '검수자' || user.role === '관리자';

  return (
    <div className="app">
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
              </div>
            )}
          </div>
        )}

        <button className={tab==='guide'?'active':''} onClick={()=>setTab('guide')}>사용방법</button>
      </nav>

      <main>
        {tab === 'dashboard' && <Dashboard user={user} />}
        {tab === 'mycalls' && <CallList user={user} mode="mine" />}
        {tab === 'guide' && <UsageGuide user={user} />}
        {tab === 'manager' && <ManagerStoreDashboardV6 user={user} />}
        {tab === 'storecalls' && <CallList user={user} mode="store" readOnly={true} />}
        {tab === 'storePerformance' && <EmployeePerformanceDashboard user={user} mode="store" />}
        {tab === 'review' && <ReviewDashboard user={user} />}
        {tab === 'performance' && <EmployeePerformanceDashboard user={user} mode="all" />}
        {tab === 'audit' && <AuditLogsViewer />}
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
function calculateCallStats(targets, latestLogByTarget, today = todayLocalISO()) {
  const total = targets.length;
  const done = targets.filter(t => latestLogByTarget[t.id]).length;
  const pending = total - done;
  const todayTargets = targets.filter(t => t.target_date === today);
  const todayDone = todayTargets.filter(t => latestLogByTarget[t.id]).length;
  const overdueTargets = targets.filter(t => !latestLogByTarget[t.id] && diffDays(t.target_date, today) > 0);
  const voc = targets.filter(t => latestLogByTarget[t.id]?.call_detail === '불만사항있음').length;
  const absent = targets.filter(t => latestLogByTarget[t.id]?.call_result === '부재중').length;
  const rejected = targets.filter(t => latestLogByTarget[t.id]?.call_result === '통화거부').length;
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
          <span>{String(item.created_at || '').slice(0, 19).replace('T', ' ')}</span>
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
        '직원관리에서 재직/퇴사/권한/비밀번호를 관리합니다.',
        '매장관리에서 운영/폐점/승계매장을 관리합니다.',
        '검수, 전체 해피콜, 직원별 현황, 감사로그를 확인합니다.'
      ]
    }
  };

  const guide = guideMap[role] || guideMap.직원;

  return (
    <div>
      <h2>사용방법</h2>
      <div className="sectionCard guideFocus">
        <h3>{guide.title}</h3>
        <ol>
          {guide.items.map((item, idx) => <li key={idx}>{item}</li>)}
        </ol>
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
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('미완료전체');

  useEffect(() => { load(); }, [mode]);

  async function load() {
    try {
      let allTargets = await fetchAllRows('happycall_targets', '*', 'target_date');
      let visible = (allTargets || []).filter(t => !t.is_skipped);
      if (mode === 'mine') visible = visible.filter(t => t.assigned_employee === user.name);
      if (mode === 'store') visible = visible.filter(t => t.assigned_store === user.store_name);
      const allLogs = await fetchAllRows('happycall_logs', '*', 'checked_at');
      setTargets(visible);
      setLogs(allLogs || []);
    } catch (e) {
      alert('해피콜 리스트 조회 오류: ' + e.message);
    }
  }

  const latestLogByTarget = useMemo(() => {
    const map = {};
    logs.forEach(l => { if (!map[l.target_id]) map[l.target_id] = l; });
    return map;
  }, [logs]);

  const stats = useMemo(() => calculateCallStats(targets, latestLogByTarget), [targets, latestLogByTarget]);

  const filteredTargets = useMemo(() => {
    let list = [...targets];
    if (filter === '반려') list = list.filter(t => latestLogByTarget[t.id]?.review_status === '반려');
    else if (filter === '경과미완료') list = list.filter(t => !latestLogByTarget[t.id] && diffDays(t.target_date) > 0);
    else if (filter === '오늘신규') list = list.filter(t => t.target_date === todayLocalISO());
    else if (filter === '미완료전체') list = list.filter(t => !latestLogByTarget[t.id] || latestLogByTarget[t.id]?.review_status === '반려');
    else if (filter === '완료') list = list.filter(t => latestLogByTarget[t.id] && latestLogByTarget[t.id]?.review_status !== '반려');
    return list.sort((a,b)=>sortTargetsByPriority(a,b,latestLogByTarget));
  }, [targets, latestLogByTarget, filter]);

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
      </div>
      <div className="list">
        {filteredTargets.map(t => {
          const log = latestLogByTarget[t.id];
          return (
            <div className="callItem" key={t.id} onClick={()=>setSelected(t)}>
              <div>
                <b>{t.join_no}</b>
                <p>{t.assigned_store} · {t.assigned_employee} · {callTypeLabel(t.call_type)}</p>
                <p className="muted">대상일 {t.target_date} / {t.skip_reason || t.assign_reason || ''}</p>
                {log?.review_status === '반려' && <p className="rejectReason">반려사유: {log.review_memo || '반려 사유 없음'}</p>}
              </div>
              {log?.review_status === '반려' ? <span className="badge rejected">반려</span> : <StatusBadge target={t} log={log} />}
            </div>
          );
        })}
      </div>
      {selected && <CallModal target={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} readOnly={readOnly} />}
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

function CallModal({ target, user, onClose, onSaved, readOnly = false }) {
  const [result, setResult] = useState('통화완료');
  const [detail, setDetail] = useState('');
  const [memo, setMemo] = useState('');
  const [history, setHistory] = useState([]);

  const rejectedInfo = useMemo(() => {
    return history.find(h => h.review_status === '반려');
  }, [history]);
  const [script, setScript] = useState(null);

  useEffect(() => { loadDetail(); }, [target.id]);

  async function loadDetail() {
    const { data: h } = await supabase.from('customers').select('*').eq('join_no', target.join_no).order('open_date', { ascending: false });
    setHistory(h || []);
    const { data: s } = await supabase.from('call_scripts').select('*').eq('call_type', target.call_type).maybeSingle();
    setScript(s);
  }

  function onResultChange(v) {
    setResult(v);
    setDetail('');
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

    try {
      const payload = {
        target_id: target.id,
        join_no: target.join_no,
        employee_name: user.name,
        call_result: result,
        call_detail: detail,
        memo,
        checked_by: user.name,
        review_status: '검수대기'
      };

      const { error } = await supabase.from('happycall_logs').insert(payload);
      if (error) throw error;

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
      alert('저장 오류: ' + e.message);
    }
  }

  return (
    <div className="modalBg">
      <div className="modal">
        <div className="modalHead"><h2>해피콜 상세</h2><button onClick={onClose}>닫기</button></div>
        <section>
          <h3>고객 기본정보</h3>
          <div className="infoGrid">
            <p><b>가입번호</b><br />{target.join_no}</p>
            <p><b>대상일</b><br />{target.target_date}</p>
            <p><b>유형</b><br />{callTypeLabel(target.call_type)}</p>
            <p><b>담당자</b><br />{target.assigned_employee}</p>
          </div>
        </section>
        <section><h3>배정 사유</h3><p className="reason">{target.assign_reason || target.skip_reason || '배정 사유 없음'}</p></section>
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

        <section>
          <h3>통화 결과</h3>
          {readOnly ? (
            <p className="muted">점장 확인 화면에서는 수정할 수 없습니다. 직원 본인만 내 해피콜 탭에서 결과를 입력할 수 있습니다.</p>
          ) : (
            <>
              <select value={result} onChange={e => onResultChange(e.target.value)}>{Object.keys(CALL_RESULTS).map(v => <option key={v}>{v}</option>)}</select>
              <select value={detail} onChange={e => setDetail(e.target.value)}>
                <option value="">상세 결과 선택</option>
                {CALL_RESULTS[result].map(v => <option key={v}>{v}</option>)}
              </select>
              <textarea value={memo} onChange={e => setMemo(e.target.value)} placeholder="메모 입력" />
              <button className="primary" onClick={save}>저장</button>
            </>
          )}
        </section>
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
        password: ''
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

    if (d.password) patch.password = d.password;
    if (patch.status === '퇴사' && !employee.resign_date) patch.resign_date = todayLocalISO();

    if (!confirm(`${employee.name} 직원 정보를 최종 저장할까요?`)) return;

    const { error } = await supabase.from('employees').update(patch).eq('id', employee.id);
    if (error) return alert(error.message);

    const detailParts = [formatAuditPatch(patch)];
    if (d.password) detailParts.push('비밀번호: 변경됨');
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
        <select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>
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
                    <div className="passwordManage">
                      <div className="currentPassword">현재: {r.password || '-'}</div>
                      <div className="passwordEdit">
                        <input value={d.password ?? ''} onChange={e=>setDraft(r.id,{password:e.target.value})} placeholder="새 비밀번호" disabled={r.status === '퇴사'} />
                        <button onClick={() => resetPassword(r)} disabled={r.status === '퇴사'}>비밀번호 초기화</button>
                      </div>
                    </div>
                  </td>
                  <td><button onClick={()=>setDetailTarget(r)}>상세</button></td>
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
            <label>입사일<input type="date" value={profile.hire_date} onChange={e=>setProfile({...profile,hire_date:e.target.value})} /></label>
            <label>퇴사일<input type="date" value={profile.resign_date} onChange={e=>setProfile({...profile,resign_date:e.target.value})} /></label>
            <button className="primary" onClick={saveProfile}>상세 저장</button>
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

  async function addHistory() {
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

      const { error } = await supabase.from('employee_store_history').insert(payload);
      if (error) throw error;

      await writeAuditLog('근무이력추가', 'employee_store_history', employee.id, user, `${employee.name} / ${form.store_name} / ${form.role} / ${form.start_date} ~ ${form.end_date || '현재'}`);
      setForm({ store_name: employee.store_name || '', role: employee.role || '직원', start_date: '', end_date: '' });
      load();
    } catch (e) {
      alert('근무이력 저장 오류: ' + e.message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteHistory(row) {
    if (!confirm('이 근무이력을 삭제할까요?')) return;

    const { error } = await supabase.from('employee_store_history').delete().eq('id', row.id);
    if (error) return alert(error.message);

    await writeAuditLog('근무이력삭제', 'employee_store_history', row.id, user, `${employee.name} / ${row.store_name} / ${row.role} / ${row.start_date} ~ ${row.end_date || '현재'}`);
    load();
  }

  return (
    <section>
      <h3>근무이력</h3>
      <div className="formGrid compact">
        <select value={form.store_name} onChange={e=>setForm({...form,store_name:e.target.value})}>
          <option value="">매장 선택</option>
          {stores.filter(s => s.name !== '관리자').map(s => <option key={s.id || s.name} value={s.name}>{s.name}</option>)}
        </select>
        <select value={form.role} onChange={e=>setForm({...form,role:e.target.value})}>
          <option>직원</option>
          <option>점장</option>
          <option>검수자</option>
          <option>관리자</option>
        </select>
        <input type="date" value={form.start_date} onChange={e=>setForm({...form,start_date:e.target.value})} />
        <input type="date" value={form.end_date} onChange={e=>setForm({...form,end_date:e.target.value})} />
        <button className="primary" onClick={addHistory} disabled={busy}>이력 추가</button>
      </div>
      <p className="muted">종료일을 비워두면 현재 근무중으로 표시됩니다.</p>

      <table>
        <thead><tr><th>매장</th><th>직책</th><th>기간</th><th>삭제</th></tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.store_name}</td>
              <td>{r.role}</td>
              <td>{r.start_date} ~ {r.end_date || '현재'}</td>
              <td><button className="dangerBtn" onClick={()=>deleteHistory(r)}>삭제</button></td>
            </tr>
          ))}
          {!rows.length && <tr><td colSpan="4" className="muted">등록된 근무이력이 없습니다.</td></tr>}
        </tbody>
      </table>
    </section>
  );
}

function ReviewDashboard({ user }) {
  const [targets, setTargets] = useState([]);
  const [logs, setLogs] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('검수대기');

  useEffect(() => { load(); }, []);

  async function load() {
    try {
      const allTargets = await fetchAllRows('happycall_targets', '*', 'target_date');
      const allLogs = await fetchAllRows('happycall_logs', '*', 'checked_at');
      setTargets((allTargets || []).filter(t => !t.is_skipped));
      setLogs(allLogs || []);
    } catch (e) {
      alert('검수 목록 조회 오류: ' + e.message);
    }
  }

  const targetById = useMemo(() => {
    const map = {};
    targets.forEach(t => { map[t.id] = t; });
    return map;
  }, [targets]);

  const reviewRows = useMemo(() => {
    let rows = logs.map(log => ({
      log,
      target: targetById[log.target_id]
    })).filter(r => r.target);

    if (filter !== '전체') {
      rows = rows.filter(r => (r.log.review_status || '검수대기') === filter);
    }

    rows.sort((a, b) => String(b.log.checked_at || '').localeCompare(String(a.log.checked_at || '')));
    return rows;
  }, [logs, targetById, filter]);

  const stats = useMemo(() => {
    const total = logs.length;
    const pending = logs.filter(l => (l.review_status || '검수대기') === '검수대기').length;
    const approved = logs.filter(l => l.review_status === '검수완료').length;
    const rejected = logs.filter(l => l.review_status === '반려').length;
    return { total, pending, approved, rejected };
  }, [logs]);

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
              <th>대상일</th>
            </tr>
          </thead>
          <tbody>
            {reviewRows.map(({log, target}) => (
              <tr key={log.id} className="clickableRow" onClick={()=>setSelected({log, target})}>
                <td>{target.join_no}</td>
                <td>{target.assigned_employee}</td>
                <td>{target.assigned_store}</td>
                <td>{log.call_result} / {log.call_detail}</td>
                <td>{log.memo ? '있음' : '-'}</td>
                <td>{log.review_status || '검수대기'}</td>
                <td>{target.target_date}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && <ReviewModal item={selected} user={user} onClose={()=>setSelected(null)} onSaved={load} />}
    </div>
  );
}

function ReviewModal({ item, user, onClose, onSaved }) {
  const { log, target } = item;
  const [memo, setMemo] = useState(log.review_memo || '');
  const [busy, setBusy] = useState(false);

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
      alert('검수 승인 오류: ' + e.message);
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

      await writeAuditLog('검수반려', 'happycall_log', log.id, user, `${target.join_no} / ${target.assigned_employee} / 반려사유: ${memo}`);
      alert('반려 처리되었습니다.');
      onSaved();
      onClose();
    } catch (e) {
      alert('반려 처리 오류: ' + e.message);
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
          </div>
        </section>

        <section>
          <h3>직원 입력 결과</h3>
          <p><b>{log.call_result}</b> / {log.call_detail}</p>
          <p className="reason">{log.memo || '메모 없음'}</p>
        </section>

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
          const joinNo = String(r[26] || '').trim();   // AA열

          if (!openDate || !joinNo) return;

          rawRows.push({
            join_no: joinNo,
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
        <p className="muted">기준 열: D=개통일자 / H=매장명 / J=담당자 / AA=가입번호</p>

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
      const [customers, employees, stores, histories] = await Promise.all([
        fetchAllRows('customers', '*', 'open_date'),
        fetchAllRows('employees', '*', 'name'),
        fetchAllRows('stores', '*', 'name'),
        fetchAllRows('assignment_history', '*', 'updated_at')
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
          const plusDate = addDays(c.open_date, p.days);
          if (targetMonth(plusDate) === targetMonthText) {
            dPlusJoinNosThisMonth.add(c.join_no);
          }
          if (plusDate === targetDate) {
            const a = decideAssignment(c, activeEmployees, stores || [], historyMap, staffByStore, {});
            rows.push({
              join_no: c.join_no,
              customer_id: c.id,
              target_date: targetDate,
              target_month: targetMonthText,
              call_type: p.type,
              assigned_store: a.assigned_store,
              assigned_employee: a.assigned_employee,
              is_skipped: false,
              skip_reason: a.reason
            });
          }
        });
      });

      const counter = {};
      (customers || []).forEach(c => {
        if (!c.open_date || !c.join_no) return;
        if (dayOfMonth(c.open_date) !== targetDay) return;
        if (dPlusJoinNosThisMonth.has(c.join_no)) return;

        const a = decideAssignment(c, activeEmployees, stores || [], historyMap, staffByStore, counter);
        rows.push({
          join_no: c.join_no,
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

      const saveRows = rows.filter(r => r.assigned_employee);
      setPreview(rows.slice(0, 150));
            // V8 assignment history sync
      for (const t of rows) {
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
        generated: rows.length,
        savable: saveRows.length,
        unassigned: rows.length - saveRows.length,
        rows,
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

      const insertRows = summary.saveRows.filter(r => {
        const key = `${r.join_no}|${r.target_date}|${r.call_type}`;
        return !existingKeys.has(key);
      });

      let saved = 0;

      for (let i = 0; i < insertRows.length; i += 500) {
        const chunk = insertRows.slice(i, i + 500);
        const { error } = await supabase.from('happycall_targets').insert(chunk);
        if (error) throw error;
        saved += chunk.length;
      }

      const historyRows = summary.saveRows.map(r => ({
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

  return (
    <div>
      <h2>해피콜 생성</h2>
      <LastAuditNotice action="해피콜대상저장" label="마지막 해피콜 대상 저장" />
      <div className="uploadBox">
        <p className="muted">대상일 기준으로 D+1, D+7, D+13, D+95, D+185와 월간 정기 해피콜을 생성합니다.</p>
        <p className="muted">당월 D+ 해피콜이 있는 고객은 해당 월의 월간 정기 해피콜에서 제외됩니다.</p>

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
                  <td>{r.join_no}</td>
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
    const rejected = targets.filter(t => latestLogByTarget[t.id]?.call_result === '통화거부').length;
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
        <table><thead><tr><th>가입번호</th><th>담당자</th><th>유형</th><th>대상일</th><th>상태</th><th>결과</th></tr></thead>
        <tbody>{targets.map(t => { const log = latestLogByTarget[t.id]; return <tr key={t.id} onClick={()=>setSelected(t)} className="clickableRow"><td>{t.join_no}</td><td>{t.assigned_employee}</td><td>{callTypeLabel(t.call_type)}</td><td>{t.target_date}</td><td>{log ? '완료' : '미완료'}</td><td>{log ? `${log.call_result} / ${log.call_detail}` : '-'}</td></tr> })}</tbody></table>
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
                <tr key={t.id} onClick={()=>setSelected(t)} className="clickableRow">
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