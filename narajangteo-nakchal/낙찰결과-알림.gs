/************************************************************************
 * 나라장터 낙찰결과(개찰결과) 일일 알림  (Google Apps Script)
 * ---------------------------------------------------------------------
 *  - 조달청_나라장터 낙찰정보서비스(공공데이터포털 15129397) 호출
 *  - 대상: 건축 분야 공사 / 감리·건설사업관리 / 설계 용역의 낙찰(개찰) 결과
 *          (금액 조건 없음 — 건축 분야만 필터)
 *  - 매일 지정 시각에 최근 개찰·낙찰 확정분을 Gmail로 발송
 *  - 기존 "입찰공고" 브리핑과 별개로 동작하는 쌍둥이 스크립트
 *
 *  ▷ 설치 4단계
 *    1) SERVICE_KEY / RECIPIENT 확인  (기존 입찰공고 스크립트와 동일 키)
 *    2) 상단 함수목록에서 pingScsbid 를 한 번 실행 → 실행로그(보기>로그)에서
 *       낙찰 API가 정상 응답하는지, 필드명이 맞는지 확인
 *    3) sendScsbidDigest 를 한 번 실행해 권한 승인 + 테스트 메일 확인
 *    4) setupScsbidTrigger 를 한 번 실행해 매일 자동실행 등록
 ************************************************************************/

// ===================== 사용자 설정 =====================
var SERVICE_KEY = '61c018bf38f643db5e45bceccfb9c6a543d9b6f11b62be76a736835acf24cd69'; // 공공데이터포털 일반 인증키(Decoding)
var RECIPIENT   = 'domoksu105@gmail.com';   // 결과 받을 이메일
var SEND_HOUR   = 18;                       // 매일 발송 시각(24h). 18 = 오후 6시 (개찰이 대부분 확정된 뒤)

// 낙찰결과는 금액 조건 없이 "건축 분야"만 필터한다.
// 용역 역할 키워드(감리/설계 분류용)
var CM_ROLE     = ['건설사업관리', '책임감리', '공사감리', '감리용역', '감리'];
var DESIGN_ROLE = ['건축설계', '설계용역', '실시설계', '기본설계', '턴키', '설계공모', '설계'];
// (1) 아래 건축 분야어가 공고명에 하나 이상 있어야 채택 (토목·플랜트 제외)
var DOMAIN_INCLUDE = ['건축','신축','증축','개축','재건축','리모델링','대수선','증개축',
  '청사','사옥','교사','관사','기숙사','생활관','숙소','근린생활','다세대','연립','공동주택',
  '아파트','오피스텔','주택','빌라','상가','체육관','강당','박물관','미술관','도서관','문화',
  '복지','복지관','어린이집','유치원','학교','병원','보건소','요양','주차장','창고동','관리동',
  '연구동','강의동','식당동','청소년','문화센터','커뮤니티','회관','센터'];
// (2) 아래 비(非)건축·설비어가 있으면 제외 (전기/소방/통신/전산 등)
var DOMAIN_EXCLUDE = ['전기','소방','통신','정보통신','전산','정보화','소프트웨어','SW',
  '전력','계장','계측제어','에너지','기계설비','승강기','조명','태양광','정보시스템',
  '관제','CCTV','네트워크','서버','LED'];

// 조회 창(시간). 개찰일시 기준으로 최근 N시간. 매일 실행이면 24~26 권장(겹치게 두면 누락↓)
var LOOKBACK_HOURS = 26;

// 개찰일시 기준 조회 구분값. 낙찰정보서비스는 보통 inqryDiv=1(공고게시일시)/2(개찰일시).
// 최근 "개찰된" 결과를 받으려면 2가 맞으나, 서비스 버전에 따라 다를 수 있어 pingScsbid로 확인.
var INQRY_DIV = 2;

// 엔드포인트 후보(위→아래 순으로 시도, 먼저 성공하는 것 사용)
var BASE_CANDIDATES = [
  'https://apis.data.go.kr/1230000/ad/ScsbidInfoService/',
  'https://apis.data.go.kr/1230000/ScsbidInfoService/'
];
// 카테고리별 오퍼레이션 후보(위→아래 순으로 시도). 낙찰현황이 없으면 개찰결과로 폴백.
var OP_CNSTWK = ['getScsbidListSttusCnstwk', 'getOpengResultListInfoCnstwk'];
var OP_SERVC  = ['getScsbidListSttusServc',  'getOpengResultListInfoServc'];
// ======================================================


/** 메인: 최근 건축 분야 낙찰결과를 모아 이메일 발송 */
function sendScsbidDigest() {
  var now = new Date();
  var bgn = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  var bgnStr = fmt(bgn);   // YYYYMMDDHHmm
  var endStr = fmt(now);

  var cnstwk = collect_(OP_CNSTWK, bgnStr, endStr);
  var servc  = collect_(OP_SERVC,  bgnStr, endStr);

  // ---- 분류 ----
  var sectionCnstwk = [];   // 건축 공사 낙찰
  var sectionCM     = [];   // 감리·건설사업관리 낙찰
  var sectionDesign = [];   // 설계 낙찰

  cnstwk.forEach(function (it) {
    var name = it.bidNtceNm || '';
    if (!hasKeyword_(name, DOMAIN_INCLUDE)) return;   // 건축 분야만
    if (hasKeyword_(name, DOMAIN_EXCLUDE)) return;    // 전기/소방/통신 등 제외
    sectionCnstwk.push(decorate_(it));
  });

  servc.forEach(function (it) {
    var name = it.bidNtceNm || '';
    var hasCM  = hasKeyword_(name, CM_ROLE);
    var hasDsn = hasKeyword_(name, DESIGN_ROLE);
    if (!hasCM && !hasDsn) return;                    // 감리·설계 아님
    if (!hasKeyword_(name, DOMAIN_INCLUDE)) return;   // 건축 분야만
    if (hasKeyword_(name, DOMAIN_EXCLUDE)) return;    // 제외어
    if (hasCM) sectionCM.push(decorate_(it));         // 감리·CM 우선
    else       sectionDesign.push(decorate_(it));
  });

  // 개찰일시 최신순 정렬
  [sectionCnstwk, sectionCM, sectionDesign].forEach(function (arr) {
    arr.sort(function (a, b) { return (b._openg || 0) - (a._openg || 0); });
  });

  var total = sectionCnstwk.length + sectionCM.length + sectionDesign.length;
  var subject = '[나라장터·낙찰결과] ' + ymd(now) + ' 개찰 ' + total + '건'
              + ' (공사 ' + sectionCnstwk.length
              + ' / 감리·CM ' + sectionCM.length
              + ' / 설계 ' + sectionDesign.length + ')';

  var html = buildHtml_(now, sectionCnstwk, sectionCM, sectionDesign);
  MailApp.sendEmail({ to: RECIPIENT, subject: subject, htmlBody: html });
  Logger.log('발송 완료: ' + subject);
}


/** 여러 오퍼레이션 후보를 순서대로 시도해 결과를 조회(페이지 수회, 공고번호+차수로 중복 제거) */
function collect_(ops, bgnStr, endStr) {
  for (var o = 0; o < ops.length; o++) {
    var rows = collectOne_(ops[o], bgnStr, endStr);
    if (rows.length) return rows;   // 결과가 나온 첫 오퍼레이션 사용
  }
  return [];
}

function collectOne_(op, bgnStr, endStr) {
  var rows = [], pageNo = 1, numOfRows = 100, maxPages = 30, seen = {};
  var base = null;

  while (pageNo <= maxPages) {
    var res = fetchPage_(op, bgnStr, endStr, pageNo, numOfRows, base);
    if (!res) break;
    base = res.base;                       // 성공한 base 고정
    var items = res.items || [];
    items.forEach(function (it) {
      // 개찰결과는 공고당 여러 순위 행이 올 수 있어 1순위(낙찰자)만 채택
      var rank = String(it.opengRank == null ? '' : it.opengRank);
      if (rank && rank !== '1' && rank !== '01') return;
      var key = (it.bidNtceNo || '') + '-' + (it.bidNtceOrd || '');
      if (!seen[key]) { seen[key] = true; rows.push(it); }
    });
    if (pageNo * numOfRows >= (res.totalCount || 0)) break;
    pageNo++;
  }
  return rows;
}


/** 한 페이지 호출. base가 null이면 후보 URL을 순서대로 시도 */
function fetchPage_(op, bgnStr, endStr, pageNo, numOfRows, base) {
  var bases = base ? [base] : BASE_CANDIDATES;
  for (var i = 0; i < bases.length; i++) {
    var url = bases[i] + op
      + '?serviceKey=' + encodeURIComponent(SERVICE_KEY)
      + '&pageNo=' + pageNo
      + '&numOfRows=' + numOfRows
      + '&inqryDiv=' + INQRY_DIV
      + '&inqryBgnDt=' + bgnStr
      + '&inqryEndDt=' + endStr
      + '&type=json';
    try {
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) continue;
      var txt = resp.getContentText();
      if (txt.indexOf('<') === 0) continue;              // XML 에러페이지면 다음 후보
      var json = JSON.parse(txt);
      var r = json.response;
      if (!r || !r.header) continue;
      if (r.header.resultCode !== '00' && r.header.resultCode !== 0) {
        Logger.log(op + ' 오류: ' + r.header.resultCode + ' ' + r.header.resultMsg);
        continue;
      }
      var body = r.body || {};
      var items = body.items;
      if (items && items.item) items = items.item;       // 구버전 대응
      if (items && !Array.isArray(items)) items = [items];
      return { base: bases[i], items: items || [], totalCount: Number(body.totalCount || 0) };
    } catch (e) {
      Logger.log('fetch 예외(' + op + '): ' + e);
    }
  }
  return null;
}


// ---------- 유틸 ----------
// 낙찰업체명 / 낙찰금액 / 낙찰률 / 개찰일시는 서비스 버전마다 필드명이 달라 후보키를 순차 탐색
function pick_(it, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = it[keys[i]];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return '';
}
function winnerOf_(it) { return pick_(it, ['bidwinnrNm','scsbidCorpNm','opengCorpNm','prcbdrNm','cmpnyNm','bidwinrNm','sucsfCorpNm']); }
function amountOf_(it) {
  var v = pick_(it, ['sucsfbidAmt','scsbidAmt','bidwinnrAmt','bidprcAmt','sucbidAmt','opengAmt']);
  var n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return (!isNaN(n) && n > 0) ? n : null;
}
function rateOf_(it)   { return pick_(it, ['sucsfbidRate','scsbidRate','bidwinnrRate','bidRate','sucbidRate','bidrt']); }
function opengOf_(it)  { return pick_(it, ['opengDt','opengDate','bidClseDt']); }
function urlOf_(it)    { return pick_(it, ['bidNtceDtlUrl','bidNtceUrl','ntceSpecDocUrl1']); }

function hasKeyword_(name, list) {
  for (var i = 0; i < list.length; i++) if (name.indexOf(list[i]) >= 0) return true;
  return false;
}

function decorate_(it) {
  var openg = parseDt_(opengOf_(it));
  it._winner   = winnerOf_(it);
  it._amt      = amountOf_(it);
  it._rate     = rateOf_(it);
  it._openg    = openg ? openg.getTime() : null;
  it._opengStr = openg ? ymdhm(openg) : '-';
  return it;
}

function buildHtml_(now, cnstwk, cm, design) {
  var css = 'font-family:Malgun Gothic,Apple SD Gothic Neo,sans-serif;font-size:13px;';
  var h = '<div style="' + css + '">';
  h += '<h2 style="margin:0 0 4px">나라장터 낙찰결과 브리핑 <span style="color:#888;font-size:13px">' + ymd(now) + '</span></h2>';
  h += '<p style="color:#555;margin:0 0 14px">공사 ' + cnstwk.length + '건 · 감리/CM ' + cm.length + '건 · 설계 ' + design.length + '건 (건축 분야, 최근 ' + LOOKBACK_HOURS + '시간 개찰 확정분)</p>';
  h += section_('① 공사 낙찰 (건축)', cnstwk);
  h += section_('② 건설사업관리·감리 낙찰 (건축)', cm);
  h += section_('③ 설계용역 낙찰 (건축)', design);
  h += '<p style="color:#999;font-size:11px;margin-top:16px">※ 개찰 1순위(낙찰예정자) 기준입니다. 낙찰금액·낙찰률·최종 확정은 나라장터 원문 링크로 확인하세요. 필드가 비어 있으면 pingScsbid 로그의 실제 필드명을 확인해 주세요.</p>';
  h += '</div>';
  return h;
}

function section_(title, rows) {
  var h = '<h3 style="margin:16px 0 6px;border-bottom:2px solid #333;padding-bottom:3px">' + title + ' <span style="color:#888;font-weight:normal">' + rows.length + '건</span></h3>';
  if (!rows.length) return h + '<p style="color:#999;margin:4px 0 0">해당 없음</p>';
  h += '<table style="border-collapse:collapse;width:100%">';
  h += '<tr style="background:#f2f2f2">'
     + th_('공고명') + th_('발주기관') + th_('낙찰업체') + th_('낙찰금액') + th_('낙찰률') + th_('개찰일시') + '</tr>';
  rows.forEach(function (it) {
    var url = urlOf_(it);
    var nm  = url ? '<a href="' + url + '">' + esc_(it.bidNtceNm) + '</a>' : esc_(it.bidNtceNm);
    h += '<tr>'
       + td_(nm)
       + td_(esc_(it.ntceInsttNm || it.dminsttNm || ''))
       + td_(esc_(it._winner || '-'))
       + td_(it._amt == null ? '-' : won_(it._amt))
       + td_(it._rate ? esc_(String(it._rate)) + '%' : '-')
       + td_(it._opengStr)
       + '</tr>';
  });
  h += '</table>';
  return h;
}

function th_(t) { return '<th style="border:1px solid #ccc;padding:5px;text-align:left">' + t + '</th>'; }
function td_(t) { return '<td style="border:1px solid #ddd;padding:5px;vertical-align:top">' + t + '</td>'; }
function esc_(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function won_(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '원'; }

function fmt(d)  { return ymd_(d) + pad(d.getHours()) + pad(d.getMinutes()); }     // YYYYMMDDHHmm
function ymd(d)  { return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
function ymd_(d) { return d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()); }
function ymdhm(d){ return ymd(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
function pad(n)  { return (n < 10 ? '0' : '') + n; }

/** "YYYYMMDDHHmm" 또는 "YYYY-MM-DD HH:mm" → Date */
function parseDt_(s) {
  if (!s) return null;
  s = String(s).replace(/[^0-9]/g, '');
  if (s.length < 8) return null;
  var y = +s.substr(0,4), m = +s.substr(4,2)-1, d = +s.substr(6,2);
  var hh = s.length >= 10 ? +s.substr(8,2) : 0;
  var mm = s.length >= 12 ? +s.substr(10,2) : 0;
  return new Date(y, m, d, hh, mm);
}


/** 매일 자동실행 트리거 등록(한 번만 실행) */
function setupScsbidTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'sendScsbidDigest') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('sendScsbidDigest').timeBased().atHour(SEND_HOUR).everyDays(1).create();
  Logger.log('매일 ' + SEND_HOUR + '시 자동실행 등록 완료');
}


/** 진단: 낙찰 API가 정상 응답하는지 + 실제 필드명 확인 (한 번 실행 후 보기>로그) */
function pingScsbid() {
  var now = new Date();
  var bgn = new Date(now.getTime() - LOOKBACK_HOURS * 3600 * 1000);
  var ops = OP_CNSTWK.concat(OP_SERVC);
  for (var b = 0; b < BASE_CANDIDATES.length; b++) {
    for (var o = 0; o < ops.length; o++) {
      var url = BASE_CANDIDATES[b] + ops[o]
        + '?serviceKey=' + encodeURIComponent(SERVICE_KEY)
        + '&pageNo=1&numOfRows=1&inqryDiv=' + INQRY_DIV
        + '&inqryBgnDt=' + fmt(bgn) + '&inqryEndDt=' + fmt(now) + '&type=json';
      try {
        var r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
        Logger.log('[' + r.getResponseCode() + '] ' + BASE_CANDIDATES[b] + ops[o]);
        Logger.log('  ' + r.getContentText().substring(0, 900));
      } catch (e) {
        Logger.log('예외 ' + ops[o] + ': ' + e);
      }
    }
  }
}
