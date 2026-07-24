import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FEATURE_DEFINITIONS } from './featureAccess.js';

async function invokeAttendance(supabase, body) {
  const { data, error } = await supabase.functions.invoke('attendance-api', { body });
  if (!error) return data;
  let message = error.message || '요청을 처리하지 못했습니다.';
  try {
    const detail = await error.context?.json?.();
    if (detail?.error) message = detail.error;
  } catch {}
  throw new Error(message);
}

function LoadingState() {
  return <div className="attendanceState"><span className="attendanceSpinner" /> 로딩 중</div>;
}

function EmptyState({ children }) {
  return <div className="attendanceState empty">{children}</div>;
}

function formatDateTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).format(new Date(value));
}

function formatTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(value));
}

function sheetSyncLabel(status) {
  if (status === 'synced') return '반영 완료';
  if (status === 'failed') return '반영 실패';
  if (status === 'not_configured') return '연결 확인 필요';
  return '반영 중';
}

function getLocation() {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve({});
    navigator.geolocation.getCurrentPosition(
      position => resolve({ latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy }),
      () => resolve({}),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

const KAKAO_MAP_APP_KEY = String(import.meta.env.VITE_KAKAO_MAP_APP_KEY || '').trim();
let kakaoMapsPromise;

function loadKakaoMaps() {
  if (!KAKAO_MAP_APP_KEY) return Promise.reject(new Error('지도 연결 키가 필요합니다.'));
  if (window.kakao?.maps?.services) return Promise.resolve(window.kakao);
  if (kakaoMapsPromise) return kakaoMapsPromise;
  kakaoMapsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-sechan-kakao-map]');
    const ready = () => window.kakao?.maps?.load(() => resolve(window.kakao));
    if (existing) {
      existing.addEventListener('load', ready, { once: true });
      existing.addEventListener('error', () => reject(new Error('지도를 불러오지 못했습니다.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.dataset.sechanKakaoMap = 'true';
    script.async = true;
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KAKAO_MAP_APP_KEY)}&autoload=false&libraries=services`;
    script.onload = ready;
    script.onerror = () => reject(new Error('지도를 불러오지 못했습니다.'));
    document.head.appendChild(script);
  });
  return kakaoMapsPromise;
}

function AttendanceLocationPicker({ value, onChange, onMessage }) {
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const geocoderRef = useRef(null);
  const [addressInput, setAddressInput] = useState(value.address || '');
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => { setAddressInput(value.address || ''); }, [value.address]);

  useEffect(() => {
    if (!KAKAO_MAP_APP_KEY || !mapContainerRef.current) return;
    let active = true;
    loadKakaoMaps().then(kakao => {
      if (!active || !mapContainerRef.current) return;
      const latitude = Number(value.latitude) || 37.566826;
      const longitude = Number(value.longitude) || 126.9786567;
      const center = new kakao.maps.LatLng(latitude, longitude);
      const map = new kakao.maps.Map(mapContainerRef.current, { center, level: Number(value.latitude) ? 3 : 8 });
      const marker = new kakao.maps.Marker({ map, position: center });
      const geocoder = new kakao.maps.services.Geocoder();
      kakao.maps.event.addListener(map, 'click', mouseEvent => {
        const position = mouseEvent.latLng;
        marker.setPosition(position);
        geocoder.coord2Address(position.getLng(), position.getLat(), result => {
          const address = result?.[0]?.road_address?.address_name || result?.[0]?.address?.address_name || '';
          onChange({
            latitude: position.getLat().toFixed(7),
            longitude: position.getLng().toFixed(7),
            address
          });
        });
      });
      mapRef.current = map;
      markerRef.current = marker;
      geocoderRef.current = geocoder;
      setMapReady(true);
    }).catch(error => onMessage(error.message));
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current || !markerRef.current || !window.kakao?.maps) return;
    const latitude = Number(value.latitude);
    const longitude = Number(value.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const position = new window.kakao.maps.LatLng(latitude, longitude);
    markerRef.current.setPosition(position);
    mapRef.current.setCenter(position);
  }, [mapReady, value.latitude, value.longitude]);

  function findAddress() {
    const address = addressInput.trim();
    if (!address) return onMessage('검색할 주소를 입력해주세요.');
    if (!geocoderRef.current) return onMessage('지도 연결 키를 설정한 뒤 주소 검색을 사용할 수 있습니다.');
    geocoderRef.current.addressSearch(address, (result, status) => {
      if (status !== window.kakao.maps.services.Status.OK || !result?.[0]) return onMessage('주소를 찾지 못했습니다. 도로명 주소로 다시 검색해주세요.');
      const latitude = Number(result[0].y).toFixed(7);
      const longitude = Number(result[0].x).toFixed(7);
      onChange({ latitude, longitude, address: result[0].road_address?.address_name || result[0].address_name || address });
      onMessage('주소 위치를 찾았습니다. 지도와 허용 반경을 확인한 뒤 저장해주세요.');
    });
  }

  async function useCurrentLocation() {
    const location = await getLocation();
    if (location.latitude == null) return onMessage('현재 위치를 확인할 수 없습니다. 브라우저 위치 권한을 허용해주세요.');
    const latitude = location.latitude.toFixed(7);
    const longitude = location.longitude.toFixed(7);
    if (geocoderRef.current) {
      geocoderRef.current.coord2Address(Number(longitude), Number(latitude), result => {
        const address = result?.[0]?.road_address?.address_name || result?.[0]?.address?.address_name || '';
        onChange({ latitude, longitude, address });
      });
    } else {
      onChange({ latitude, longitude });
    }
    onMessage('현재 위치를 입력했습니다. 위치와 허용 반경을 확인한 뒤 저장해주세요.');
  }

  return <div className="attendanceLocationPicker full">
    <div className="attendanceAddressRow">
      <label>매장 주소<input value={addressInput} onChange={event => setAddressInput(event.target.value)} placeholder="예: 경기도 파주시 금촌동 중앙로 00" /></label>
      <button type="button" className="attendanceSecondary" onClick={findAddress}>주소 찾기</button>
      <button type="button" className="attendanceSecondary" onClick={useCurrentLocation}>현재 위치로 지정</button>
    </div>
    {KAKAO_MAP_APP_KEY
      ? <><div ref={mapContainerRef} className="attendanceMap" aria-label="출근 위치 지도" /><p className="attendanceMapHelp">지도를 눌러 정확한 출근 위치를 지정할 수 있습니다.</p></>
      : <div className="attendanceMapUnavailable">지도 연결 키를 등록하면 주소 검색과 지도 선택이 활성화됩니다. 현재 위치 지정은 지금도 사용할 수 있습니다.</div>}
    <details className="attendanceCoordinateDetails">
      <summary>좌표 직접 확인·수정</summary>
      <div>
        <label>위도<input type="number" step="0.0000001" value={value.latitude} onChange={event => onChange({ latitude: event.target.value })} /></label>
        <label>경도<input type="number" step="0.0000001" value={value.longitude} onChange={event => onChange({ longitude: event.target.value })} /></label>
      </div>
    </details>
  </div>;
}

export default function AttendanceModule({ supabase, user, superAdmin = false }) {
  const [view, setView] = useState('attendance');
  const [status, setStatus] = useState(null);
  const [pending, setPending] = useState([]);
  const [todayAttendance, setTodayAttendance] = useState({ records: [], summary: { total: 0, synced: 0, pending: 0, failed: 0 } });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [requestForm, setRequestForm] = useState({ work_date: '', destination_store_id: '', reason: '' });

  const canApprove = user.role === '점장' || superAdmin;
  const canViewTodayAttendance = user.role === '관리자' || superAdmin;
  const tabs = [
    { key: 'attendance', label: '출근 현황', show: true },
    { key: 'records', label: '출근 내역', show: canViewTodayAttendance },
    { key: 'approvals', label: '타 매장 출근 승인', show: canApprove },
    { key: 'settings', label: '매장 출근 설정', show: superAdmin }
  ].filter(tab => tab.show);

  async function load() {
    setLoading(true);
    setMessage('');
    try {
      const [currentResult, approvalResult, attendanceResult] = await Promise.allSettled([
        invokeAttendance(supabase, { action: 'current-status' }),
        canApprove ? invokeAttendance(supabase, { action: 'manager-pending' }) : Promise.resolve({ requests: [] }),
        canViewTodayAttendance ? invokeAttendance(supabase, { action: 'today-attendance' }) : Promise.resolve(null)
      ]);
      if (currentResult.status === 'rejected') throw currentResult.reason;
      const current = currentResult.value;
      setStatus(current);
      setRequestForm(previous => ({ ...previous, work_date: previous.work_date || current.today }));
      if (approvalResult.status === 'fulfilled') setPending(approvalResult.value.requests || []);
      if (attendanceResult.status === 'fulfilled' && attendanceResult.value) setTodayAttendance(attendanceResult.value);
      if (approvalResult.status === 'rejected' || attendanceResult.status === 'rejected') {
        setMessage('일부 관리 자료를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.');
      }
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function checkIn() {
    if (!confirm('현재 매장에서 출근 처리할까요?')) return;
    setBusy(true);
    setMessage('');
    try {
      try {
        await invokeAttendance(supabase, { action: 'check-in' });
      } catch (wifiError) {
        if (!String(wifiError.message || '').includes('WiFi 또는 위치')) throw wifiError;
        const location = await getLocation();
        if (location.latitude == null) throw new Error('매장 WiFi가 확인되지 않았고 현재 위치도 확인할 수 없습니다. 휴대폰의 위치 권한을 허용한 뒤 다시 시도해주세요.');
        await invokeAttendance(supabase, { action: 'check-in', ...location });
      }
      await load();
      setMessage('출근 처리가 완료되었습니다.');
      alert('출근 처리가 완료되었습니다.');
    } catch (error) {
      setMessage(error.message);
    } finally { setBusy(false); }
  }

  async function submitOtherStore(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      await invokeAttendance(supabase, { action: 'request-other-store', ...requestForm });
      setRequestForm(previous => ({ ...previous, destination_store_id: '', reason: '' }));
      setMessage('타 매장 출근 요청을 보냈습니다.');
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function requestAction(action, requestId, decision = '') {
    setBusy(true);
    setMessage('');
    try {
      await invokeAttendance(supabase, { action, request_id: requestId, decision });
      setMessage(decision === 'approved' ? '승인했습니다.' : decision === 'rejected' ? '반려했습니다.' : '요청을 취소했습니다.');
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  async function retrySheetSync(recordId) {
    setBusy(true);
    setMessage('');
    try {
      await invokeAttendance(supabase, { action: 'retry-sheet-sync', record_id: recordId });
      setMessage('근무표에 다시 반영했습니다.');
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  if (loading) return <section className="attendancePage"><h2>근무</h2><LoadingState /></section>;
  if (!status?.enabled && !superAdmin) {
    return <section className="attendancePage"><h2>근무</h2><EmptyState>근무 기능 사용 권한이 없습니다.</EmptyState></section>;
  }

  return (
    <section className="attendancePage">
      <div className="attendanceTitleRow">
        <div><p className="attendanceEyebrow">세찬컴퍼니</p><h2>근무</h2></div>
        <button type="button" className="attendanceRefresh" onClick={load}>새로고침</button>
      </div>

      {tabs.length > 1 && <div className="attendanceTopTabs" aria-label="출근 현황 및 매장 출근 설정 메뉴" style={{ '--attendance-tab-count': tabs.length }}>
        {tabs.map(tab => <button key={tab.key} className={view === tab.key ? 'active' : ''} onClick={() => setView(tab.key)}>{tab.label}</button>)}
      </div>}

      {message && <div className="attendanceMessage" role="status">{message}</div>}

      {view === 'attendance' && <>
        <div className="attendanceSummaryGrid">
          <article><span>오늘 날짜</span><strong>{status?.today || '-'}</strong></article>
          <article><span>출근 상태</span><strong>{status?.record ? `출근 완료 ${formatTime(status.record.checked_in_at)}` : status?.schedule?.dayOff ? '휴무' : '출근 전'}</strong></article>
        </div>

        <div className="attendancePanel attendanceCheckinPanel">
          <div>
            <h3>오늘 출근</h3>
            {status?.record
              ? <p>{formatDateTime(status.record.checked_in_at)} · {status.record.checkin_store_name} · {status.record.verification_method === 'wifi' ? '매장 WiFi' : '매장 위치'}</p>
              : <p>{status?.scheduleError || '매장 WiFi 또는 위치가 확인되면 출근할 수 있습니다.'}</p>}
          </div>
          <button type="button" className="attendancePrimary" disabled={busy || Boolean(status?.record) || Boolean(status?.schedule?.dayOff) || Boolean(status?.scheduleError)} onClick={checkIn}>
            {status?.record ? '출근 완료' : '출근하기'}
          </button>
        </div>

        <div className="attendanceTwoColumn">
          <div className="attendancePanel">
            <h3>타 매장 출근 요청</h3>
            <p className="attendanceHelp">소속 매장 출근은 그대로 가능하며, 승인된 타 매장은 해당 날짜에 한 번 사용할 수 있습니다. 당일 요청은 낮 12시 전까지만 가능합니다.</p>
            <form className="attendanceForm" onSubmit={submitOtherStore}>
              <label>출근 날짜<input type="date" value={requestForm.work_date} min={status?.today} onChange={event => setRequestForm({ ...requestForm, work_date: event.target.value })} required /></label>
              <label>출근 매장<select value={requestForm.destination_store_id} onChange={event => setRequestForm({ ...requestForm, destination_store_id: event.target.value })} required><option value="">선택</option>{(status?.stores || []).filter(store => store.name !== user.store_name).map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
              <label className="full">사유<textarea value={requestForm.reason} onChange={event => setRequestForm({ ...requestForm, reason: event.target.value })} placeholder="타 매장에서 출근해야 하는 이유를 입력해주세요." required /></label>
              <button type="submit" className="attendanceSecondary" disabled={busy}>승인 요청</button>
            </form>
            <div className="attendanceCards">
              {(status?.requests || []).length ? status.requests.map(request => <article key={request.id}>
                <div><strong>{request.work_date} · {request.destination_store_name}</strong><span>{request.reason}</span></div>
                <div className="attendanceCardRight"><em className={`attendanceBadge ${request.status}`}>{request.status === 'pending' ? '승인 대기' : request.status === 'approved' ? '승인 완료' : request.status === 'rejected' ? '반려' : request.status === 'used' ? '사용 완료' : '취소'}</em>{['pending', 'approved'].includes(request.status) && <button type="button" disabled={busy} onClick={() => requestAction('cancel-request', request.id)}>취소</button>}</div>
              </article>) : <EmptyState>진행 중인 타 매장 출근 요청이 없습니다.</EmptyState>}
            </div>
          </div>

          <div className="attendancePanel">
            <h3>내 출근 이력</h3>
            <div className="attendanceDesktopTable"><table><thead><tr><th>날짜</th><th>출근시간</th><th>매장</th><th>확인</th><th>근무표</th></tr></thead><tbody>{(status?.history || []).map(record => <tr key={record.id}><td>{record.work_date}</td><td>{formatDateTime(record.checked_in_at).split(' ').slice(-2).join(' ')}</td><td>{record.checkin_store_name}</td><td>{record.verification_method === 'wifi' ? 'WiFi' : '위치'}</td><td>{record.sheet_sync_status === 'synced' ? '반영 완료' : <button type="button" className="attendanceRetry" disabled={busy} onClick={() => retrySheetSync(record.id)}>다시 반영</button>}</td></tr>)}</tbody></table></div>
            <div className="attendanceMobileList">{(status?.history || []).map(record => <article key={record.id}><div><strong>{record.work_date}</strong><span>{record.checkin_store_name} · {record.verification_method === 'wifi' ? 'WiFi' : '위치'}</span></div><div><strong>{formatDateTime(record.checked_in_at).split(' ').slice(-2).join(' ')}</strong>{record.sheet_sync_status === 'synced' ? <span>근무표 반영</span> : <button type="button" className="attendanceRetry" disabled={busy} onClick={() => retrySheetSync(record.id)}>다시 반영</button>}</div></article>)}</div>
            {!(status?.history || []).length && <EmptyState>출근 이력이 없습니다.</EmptyState>}
          </div>
        </div>

      </>}

      {view === 'records' && canViewTodayAttendance && <div className="attendancePanel attendanceTodayPanel">
        <div className="attendancePanelHeading">
          <div><h3>당일 출근 내역</h3><p className="attendanceHelp">{status?.today} 출근 기록과 구글 근무표 반영 여부입니다.</p></div>
        </div>
        <div className="attendanceTodaySummary">
          <article><span>오늘 출근</span><strong>{todayAttendance.summary.total}명</strong></article>
          <article><span>반영 완료</span><strong>{todayAttendance.summary.synced}명</strong></article>
          <article><span>반영 중</span><strong>{todayAttendance.summary.pending}명</strong></article>
          <article className={todayAttendance.summary.failed ? 'warning' : ''}><span>반영 실패</span><strong>{todayAttendance.summary.failed}명</strong></article>
        </div>
        <div className="attendanceDesktopTable"><table><thead><tr><th>직원</th><th>소속 매장</th><th>출근 매장</th><th>출근 시각</th><th>확인 방식</th><th>구글 근무표</th></tr></thead><tbody>
          {todayAttendance.records.map(record => <tr key={record.id}><td>{record.employee_name}</td><td>{record.home_store_name}</td><td>{record.checkin_store_name}</td><td>{formatTime(record.checked_in_at)}</td><td>{record.verification_method === 'wifi' ? 'WiFi' : 'GPS'}</td><td><span className={`attendanceSyncBadge ${record.sheet_sync_status}`}>{sheetSyncLabel(record.sheet_sync_status)}</span>{record.sheet_sync_status !== 'synced' && <button type="button" className="attendanceRetry" disabled={busy} onClick={() => retrySheetSync(record.id)}>다시 반영</button>}</td></tr>)}
        </tbody></table></div>
        <div className="attendanceMobileList attendanceTodayMobile">
          {todayAttendance.records.map(record => <article key={record.id}>
            <div><strong>{record.employee_name}</strong><span>{record.home_store_name} · {formatTime(record.checked_in_at)}</span><span>출근 매장 {record.checkin_store_name} · {record.verification_method === 'wifi' ? 'WiFi' : 'GPS'}</span></div>
            <div className="attendanceCardRight"><span className={`attendanceSyncBadge ${record.sheet_sync_status}`}>{sheetSyncLabel(record.sheet_sync_status)}</span>{record.sheet_sync_status !== 'synced' && <button type="button" className="attendanceRetry" disabled={busy} onClick={() => retrySheetSync(record.id)}>다시 반영</button>}</div>
          </article>)}
        </div>
        {!todayAttendance.records.length && <EmptyState>오늘 출근한 직원이 없습니다.</EmptyState>}
      </div>}

      {view === 'approvals' && canApprove && <div className="attendancePanel">
          <h3>타 매장 출근 승인</h3>
          <div className="attendanceCards approval">{pending.length ? pending.map(request => <article key={request.id}>
            <div><strong>{request.employee_name} · {request.work_date}</strong><span>{request.home_store_name} → {request.destination_store_name}</span><span>{request.reason}</span></div>
            <div className="attendanceApprovalButtons"><button disabled={busy} onClick={() => requestAction('decide-request', request.id, 'rejected')}>반려</button><button className="attendancePrimary" disabled={busy} onClick={() => requestAction('decide-request', request.id, 'approved')}>승인</button></div>
          </article>) : <EmptyState>승인 대기 중인 요청이 없습니다.</EmptyState>}</div>
        </div>}

      {view === 'settings' && superAdmin && <StoreAttendanceSettings supabase={supabase} />}
    </section>
  );
}

export function FeatureAccessManager({ supabase }) {
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [savedDraft, setSavedDraft] = useState({});
  const [selected, setSelected] = useState([]);
  const [search, setSearch] = useState('');
  const [storeFilter, setStoreFilter] = useState('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [bulkFeature, setBulkFeature] = useState('attendance');
  const [bulkMode, setBulkMode] = useState('enabled');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load() {
    try {
      const nextData = await invokeAttendance(supabase, { action: 'admin-data' });
      const nextDraft = {};
      for (const employee of nextData.employees || []) {
        nextDraft[employee.id] = {};
        for (const feature of FEATURE_DEFINITIONS) {
          const row = (nextData.overrides || []).find(item =>
            item.scope_type === 'employee' && item.employee_id === employee.id && item.feature_key === feature.key
          );
          nextDraft[employee.id][feature.key] = row ? (row.enabled ? 'enabled' : 'disabled') : 'inherit';
        }
      }
      setData(nextData);
      setDraft(nextDraft);
      setSavedDraft(JSON.parse(JSON.stringify(nextDraft)));
      setSelected(previous => previous.filter(id => nextData.employees?.some(employee => employee.id === id)));
    }
    catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, []);

  const stores = useMemo(() => [...new Set((data?.employees || []).map(employee => employee.store_name).filter(Boolean))].sort(), [data]);
  const roles = useMemo(() => [...new Set((data?.employees || []).map(employee => employee.role).filter(Boolean))].sort(), [data]);
  const filteredEmployees = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return (data?.employees || []).filter(employee =>
      (storeFilter === 'all' || employee.store_name === storeFilter) &&
      (roleFilter === 'all' || employee.role === roleFilter) &&
      (!keyword || `${employee.name} ${employee.store_name} ${employee.role}`.toLowerCase().includes(keyword))
    );
  }, [data, search, storeFilter, roleFilter]);
  const changed = useMemo(() => Object.keys(draft).flatMap(employeeId =>
    FEATURE_DEFINITIONS.filter(feature => draft[employeeId]?.[feature.key] !== savedDraft[employeeId]?.[feature.key])
      .map(feature => ({ target_id: employeeId, feature_key: feature.key, mode: draft[employeeId][feature.key] }))
  ), [draft, savedDraft]);
  const visibleIds = filteredEmployees.map(employee => employee.id);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every(id => selected.includes(id));

  function setMode(employeeId, featureKey, mode) {
    setDraft(previous => ({ ...previous, [employeeId]: { ...previous[employeeId], [featureKey]: mode } }));
  }

  function toggleVisibleSelection() {
    setSelected(previous => allVisibleSelected
      ? previous.filter(id => !visibleIds.includes(id))
      : [...new Set([...previous, ...visibleIds])]);
  }

  function applyBulk() {
    if (!selected.length) return setMessage('먼저 직원을 선택해주세요.');
    setDraft(previous => {
      const next = { ...previous };
      for (const employeeId of selected) next[employeeId] = { ...next[employeeId], [bulkFeature]: bulkMode };
      return next;
    });
    setMessage(`${selected.length}명의 ${FEATURE_DEFINITIONS.find(item => item.key === bulkFeature)?.label} 설정을 변경했습니다. 아래 저장 버튼을 눌러 최종 반영해주세요.`);
  }

  async function saveAll() {
    if (!changed.length) return setMessage('저장할 변경사항이 없습니다.');
    setBusy(true); setMessage('');
    try {
      await invokeAttendance(supabase, { action: 'save-feature-overrides', changes: changed });
      setMessage(`${changed.length}개의 기능 사용 권한을 저장했습니다.`);
      await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  if (!data) return <LoadingState />;
  return <section className="attendancePage">
    <div className="attendanceTitleRow">
      <div><p className="attendanceEyebrow">최고관리자 전용</p><h2>기능 사용 권한</h2></div>
    </div>
    <div className="attendancePanel">
    <h3>직원별 기능 설정</h3>
    <p className="attendanceHelp">직원관리 목록처럼 한 화면에서 검색·선택하고 여러 직원의 기능을 한꺼번에 설정할 수 있습니다. 기존 역할 권한을 높이지 않고 선택한 기능의 사용 여부만 제한합니다.</p>
    {message && <div className="attendanceMessage">{message}</div>}
    <div className="featureAccessToolbar">
      <input aria-label="직원 검색" value={search} onChange={event => setSearch(event.target.value)} placeholder="직원명·매장·직책 검색" />
      <select aria-label="매장 필터" value={storeFilter} onChange={event => setStoreFilter(event.target.value)}><option value="all">전체 매장</option>{stores.map(store => <option key={store}>{store}</option>)}</select>
      <select aria-label="직책 필터" value={roleFilter} onChange={event => setRoleFilter(event.target.value)}><option value="all">전체 직책</option>{roles.map(role => <option key={role}>{role}</option>)}</select>
    </div>
    <div className="featureBulkBar">
      <strong>{selected.length}명 선택</strong>
      <select aria-label="일괄 적용 기능" value={bulkFeature} onChange={event => setBulkFeature(event.target.value)}>{FEATURE_DEFINITIONS.map(feature => <option key={feature.key} value={feature.key}>{feature.label}</option>)}</select>
      <select aria-label="일괄 적용 상태" value={bulkMode} onChange={event => setBulkMode(event.target.value)}><option value="enabled">사용</option><option value="disabled">미사용</option><option value="inherit">기본값</option></select>
      <button type="button" className="attendanceSecondary" onClick={applyBulk} disabled={busy}>선택 직원 일괄 적용</button>
    </div>
    <div className="featureAccessTable attendanceDesktopTable">
      <table>
        <thead><tr><th><input type="checkbox" aria-label="현재 목록 전체 선택" checked={allVisibleSelected} onChange={toggleVisibleSelection} /></th><th>직원</th><th>소속·직책</th>{FEATURE_DEFINITIONS.map(feature => <th key={feature.key}>{feature.label}</th>)}</tr></thead>
        <tbody>{filteredEmployees.map(employee => <tr key={employee.id}>
          <td><input type="checkbox" aria-label={`${employee.name} 선택`} checked={selected.includes(employee.id)} onChange={() => setSelected(previous => previous.includes(employee.id) ? previous.filter(id => id !== employee.id) : [...previous, employee.id])} /></td>
          <td><strong>{employee.name}</strong></td><td>{employee.store_name} · {employee.role}</td>
          {FEATURE_DEFINITIONS.map(feature => <td key={feature.key}><select aria-label={`${employee.name} ${feature.label}`} value={draft[employee.id]?.[feature.key] || 'inherit'} onChange={event => setMode(employee.id, feature.key, event.target.value)}><option value="inherit">기본값</option><option value="enabled">사용</option><option value="disabled">미사용</option></select></td>)}
        </tr>)}</tbody>
      </table>
    </div>
    <div className="featureAccessMobileList">
      {filteredEmployees.map(employee => <article key={employee.id}>
        <header><label><input type="checkbox" checked={selected.includes(employee.id)} onChange={() => setSelected(previous => previous.includes(employee.id) ? previous.filter(id => id !== employee.id) : [...previous, employee.id])} /><span><strong>{employee.name}</strong><small>{employee.store_name} · {employee.role}</small></span></label></header>
        <div>{FEATURE_DEFINITIONS.map(feature => <label key={feature.key}><span>{feature.label}</span><select value={draft[employee.id]?.[feature.key] || 'inherit'} onChange={event => setMode(employee.id, feature.key, event.target.value)}><option value="inherit">기본값</option><option value="enabled">사용</option><option value="disabled">미사용</option></select></label>)}</div>
      </article>)}
    </div>
    {!filteredEmployees.length && <EmptyState>조건에 맞는 직원이 없습니다.</EmptyState>}
    <div className="featureAccessSaveBar"><span>변경사항 {changed.length}개</span><button type="button" className="attendancePrimary" onClick={saveAll} disabled={busy || !changed.length}>{busy ? '저장 중' : '전체 변경사항 저장'}</button></div>
    </div>
  </section>;
}

function StoreAttendanceSettings({ supabase }) {
  const [data, setData] = useState(null);
  const [storeId, setStoreId] = useState('');
  const [form, setForm] = useState({ enabled: false, auth_mode: 'either', address: '', latitude: '', longitude: '', radius_meters: 100, default_start_time: '', ips: '' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function load() {
    try { setData(await invokeAttendance(supabase, { action: 'admin-data' })); }
    catch (error) { setMessage(error.message); }
  }
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!data) return;
    const nextId = storeId || data.stores?.[0]?.id || '';
    setStoreId(nextId);
    const setting = (data.settings || []).find(item => item.store_id === nextId) || {};
    const ips = (data.ips || []).filter(item => item.store_id === nextId).map(item => item.ip_address).join('\n');
    setForm({ enabled: Boolean(setting.enabled), auth_mode: setting.auth_mode || 'either', address: setting.address || '', latitude: setting.latitude ?? '', longitude: setting.longitude ?? '', radius_meters: setting.radius_meters || 100, default_start_time: setting.default_start_time || '', ips });
  }, [data, storeId]);

  async function save(event) {
    event.preventDefault(); setBusy(true); setMessage('');
    try {
      await invokeAttendance(supabase, { action: 'save-store-setting', store_id: storeId, ...form, ips: form.ips.split(/[,\n]/).map(value => value.trim()).filter(Boolean) });
      setMessage('매장 출근 설정을 저장했습니다.'); await load();
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }

  if (!data) return <LoadingState />;
  return <div className="attendancePanel">
    <h3>매장·사무실 출근 설정</h3>
    <p className="attendanceHelp">매장과 사무실의 주소 또는 지도 위치와 WiFi를 등록합니다. WiFi 또는 GPS 중 하나가 확인되면 출근할 수 있도록 설정하는 방식을 권장합니다.</p>
    {message && <div className="attendanceMessage">{message}</div>}
    <form className="storeAttendanceForm" onSubmit={save}>
      <label>매장<select value={storeId} onChange={event => setStoreId(event.target.value)}>{(data.stores || []).map(store => <option key={store.id} value={store.id}>{store.name}</option>)}</select></label>
      <label className="toggleLabel"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} /> 출근 기능 활성화</label>
      <label>확인 방식<select value={form.auth_mode} onChange={event => setForm({ ...form, auth_mode: event.target.value })}><option value="either">WiFi 또는 GPS</option><option value="wifi">WiFi만</option><option value="gps">GPS만</option></select></label>
      <label>기본 출근시간<input type="time" value={form.default_start_time} onChange={event => setForm({ ...form, default_start_time: event.target.value })} /></label>
      <AttendanceLocationPicker value={form} onMessage={setMessage} onChange={changes => setForm(previous => ({ ...previous, ...changes }))} />
      <label className="full">GPS 허용 반경(m)<input type="number" min="30" max="1000" value={form.radius_meters} onChange={event => setForm({ ...form, radius_meters: event.target.value })} /></label>
      <label className="full">매장 WiFi 공인 IP<textarea value={form.ips} onChange={event => setForm({ ...form, ips: event.target.value })} placeholder="IP가 여러 개면 줄을 바꿔 입력해주세요." /></label>
      {data.current_ip && <button type="button" className="attendanceSecondary full" onClick={() => setForm({ ...form, ips: [...new Set([...form.ips.split(/[,\n]/).map(value => value.trim()).filter(Boolean), data.current_ip])].join('\n') })}>현재 접속 IP 추가: {data.current_ip}</button>}
      <button type="submit" className="attendancePrimary full" disabled={busy}>매장 설정 저장</button>
    </form>
  </div>;
}
