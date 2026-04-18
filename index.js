// @ts-nocheck

const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { google } = require('googleapis');

// ================== 설정 ==================
const TOKEN = process.env.TOKEN;
const PORT = Number(process.env.PORT || 3000);
const GUILD_ID = '1018194815286001756';

// 인교단 진급 스프레드시트 ID
const SPREADSHEET_ID = '1EhC_xDBXR7mm7_KdVPp2dKPjNSKClcEEHIZT6ZPvfaQ';
const GOOGLE_SERVICE_ACCOUNT_EMAIL = 'fmb1004yopy@theta-terrain-488918-n7.iam.gserviceaccount.com';

// ================== Railway용: 서비스계정 JSON을 env로 받아 파일로 생성 ==================
function ensureGoogleKeyFile() {
  const envJson = process.env.GOOGLE_SA_JSON;
  const filePath = process.env.GOOGLE_KEYFILE || path.join(__dirname, 'service-account.json');

  if (envJson) {
    let parsed;
    try {
      parsed = JSON.parse(envJson);
    } catch (err) {
      console.error('❌ GOOGLE_SA_JSON 파싱 실패:', err);
      throw err;
    }

    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }

    if (parsed.client_email && parsed.client_email !== GOOGLE_SERVICE_ACCOUNT_EMAIL) {
      console.log(
        `⚠️ GOOGLE_SA_JSON의 client_email이 예상과 다릅니다: ${parsed.client_email} ` +
        `(예상: ${GOOGLE_SERVICE_ACCOUNT_EMAIL})`
      );
    }

    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    console.log(`✅ Google service account key written to: ${filePath} (${parsed.client_email || 'client_email 없음'})`);
    return filePath;
  }

  if (fs.existsSync(filePath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      console.log(`✅ Google service account key loaded from file: ${filePath} (${existing.client_email || 'client_email 없음'})`);
      if (existing.client_email && existing.client_email !== GOOGLE_SERVICE_ACCOUNT_EMAIL) {
        console.log(
          `⚠️ Google service account email 확인 필요: ${existing.client_email} ` +
          `(예상: ${GOOGLE_SERVICE_ACCOUNT_EMAIL})`
        );
      }
    } catch (err) {
      console.log(`⚠️ 기존 Google keyfile을 읽을 수 없습니다: ${filePath}`);
    }
    return filePath;
  }

  console.log('❌ GOOGLE_SA_JSON 환경변수가 없고, service-account.json 파일도 없습니다.');
  return filePath;
}

const GOOGLE_KEYFILE = ensureGoogleKeyFile();

// 구글 인증
const gAuth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function appendRowToSheet(rangeA1, values) {
  const sheets = google.sheets({ version: 'v4', auth: gAuth });

  const result = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: rangeA1,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] }
  });

  console.log(`✅ 구글시트 저장 완료: ${result.data?.updates?.updatedRange || rangeA1}`);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

function startHealthServer() {
  const server = http.createServer((req, res) => {
    const isHealthPath = req.url === '/' || req.url === '/health';
    const status = isHealthPath ? 200 : 404;

    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: isHealthPath,
      bot: client.user?.tag || null,
      uptime: Math.floor(process.uptime())
    }));
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Health server listening on port ${PORT}`);
  });

  return server;
}

// ================== 역할 ID ==================
const MANAGER_ROLE_IDS = [
  '1485118940115107860',
  '1485155855321010226',
  '1480916945963585566'
]; // 모든 관리 명령어 사용 가능

const HR_ADMIN_ROLE_ID = '1018195906807480402'; // /강등대상 포함 대상 역할
const DEMOTION_EXCLUDED_ROLE_IDS = [
  '1486229581190004752',
  '1481672725012549754'
]; // /강등대상 제외 역할
const MAJOR_ROLE_ID = '1472582859339596091';    // 소령행정보고 / 소령 점수 포함
const LTCOL_ROLE_ID = '1018447060627894322';    // 중령행정보고 / 중령 점수 포함

// 점수 조회 포함 역할
const SCORE_INCLUDED_ROLE_IDS = {
  소령: MAJOR_ROLE_ID,
  중령: LTCOL_ROLE_ID
};

// 강등 대상 관련
const DEMOTION_REQUIRED_ROLE_IDS = [
  HR_ADMIN_ROLE_ID
];

const DEMOTION_ALLOWED_ROLE_IDS = MANAGER_ROLE_IDS;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'ingyodan_admin_data.json');

// ================== 데이터 구조 ==================
let data = {
  소령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
  중령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' }
};

// ================== 런타임 캐시 ==================
const dayTotalsCache = new Map(); // `${rankName}|${dateStr}` -> Map(userId->total)
const paginationSessions = new Map();

// ================== 데이터 저장 ==================
function loadData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } else {
    saveData();
  }

  if (!data.소령) data.소령 = { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' };
  if (!data.중령) data.중령 = { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' };

  if (!data.소령.history) data.소령.history = { daily: {}, weekly: {} };
  if (!data.중령.history) data.중령.history = { daily: {}, weekly: {} };
  if (!data.소령.history.daily) data.소령.history.daily = {};
  if (!data.중령.history.daily) data.중령.history.daily = {};
  if (!data.소령.history.weekly) data.소령.history.weekly = {};
  if (!data.중령.history.weekly) data.중령.history.weekly = {};
  if (!data.소령.lastWeekStart) data.소령.lastWeekStart = '';
  if (!data.중령.lastWeekStart) data.중령.lastWeekStart = '';
  if (!data.소령.users) data.소령.users = {};
  if (!data.중령.users) data.중령.users = {};

  dayTotalsCache.clear();
  paginationSessions.clear();
}

function saveData() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ================== 날짜 (새벽 2시 기준) ==================
function getReportDate() {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // KST
  if (now.getHours() < 2) now.setDate(now.getDate() - 1);
  return now.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function getYesterdayDate() {
  return addDays(getReportDate(), -1);
}

function getSundayWeekStart(dateStr) {
  const d = new Date(`${dateStr}T12:00:00+09:00`);
  const day = d.getUTCDay(); // 0=일
  return addDays(dateStr, -day);
}

// ================== 공용 유틸 ==================
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function hasAnyRole(member, roleIds) {
  return member?.roles?.cache?.some(r => roleIds.includes(r.id));
}

function daysSinceJoined(member) {
  const joined = member?.joinedAt;
  if (!joined) return 9999;
  const diffMs = Date.now() - joined.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function getRankNameForMember(member) {
  const hasMajor = member.roles.cache.has(MAJOR_ROLE_ID);
  const hasLtCol = member.roles.cache.has(LTCOL_ROLE_ID);
  if (hasMajor) return '소령';
  if (hasLtCol) return '중령';
  return null;
}

function recomputeTotals(group) {
  for (const u of Object.values(group.users || {})) {
    let a = 0;
    let e = 0;
    if (u.daily) {
      for (const d of Object.values(u.daily)) {
        a += (d?.admin || 0);
        e += (d?.extra || 0);
      }
    }
    u.totalAdmin = a;
    u.totalExtra = e;
  }
}

// ================== /초기화주간 ==================
function clearPrev7ReportDaysBeforeThisWeek(group) {
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  const rangeStart = addDays(thisWeekStart, -7);
  const rangeEnd = thisWeekStart;

  let clearedEntries = 0;

  for (const u of Object.values(group.users || {})) {
    if (!u.daily) continue;
    for (const dateKey of Object.keys(u.daily)) {
      if (dateKey >= rangeStart && dateKey < rangeEnd) {
        delete u.daily[dateKey];
        clearedEntries++;
      }
    }
  }

  recomputeTotals(group);
  return { rangeStart, rangeEnd, clearedEntries, thisWeekStart, today };
}

// ================== 계산 함수 ==================
function calculateAdminUnits(input) {
  return (
    (input.진급처리 || 0) * 1 +
    (input.인증처리 || 0) * 1.5 +
    (input.행정처리 || 0) * 1 +
    (input.전역전출처리 || 0) * 1
  );
}

function calculateExtraPoints(input) {
  return (
    (input.보직모집 || 0) * 1.5 +
    (input.인게임시험 || 0) * 1
  );
}

function getTopPercentFromRank(rank, n) {
  if (n <= 1) return 1;
  return Math.round(((rank - 1) / (n - 1)) * 99) + 1;
}

function getAdminPointsByPercentile(pct) {
  if (pct <= 10) return 70;
  if (pct <= 34) return 50;
  if (pct <= 66) return 40;
  if (pct <= 90) return 30;
  return 20;
}

// 점수 조회 포함 기준:
// 소령 = 1472582859339596091
// 중령 = 1018447060627894322
async function getEligibleMemberIdsByRank(guild, rankName) {
  const members = await guild.members.fetch();
  const requiredRole = SCORE_INCLUDED_ROLE_IDS[rankName];

  const ids = [];
  for (const [, m] of members) {
    if (m.user?.bot) continue;
    if (!m.roles.cache.has(requiredRole)) continue;
    ids.push(m.id);
  }
  return ids;
}

// ================== 점수 계산 핵심 ==================
function buildDayScoresForMembers(rankName, dateStr, memberIds) {
  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 2 : 3;
  const group = is소령 ? data.소령 : data.중령;

  const rows = (memberIds || []).map((userId) => {
    const u = group.users?.[userId];
    const adminUnits = u?.daily?.[dateStr]?.admin ?? 0;
    const extraRaw = u?.daily?.[dateStr]?.extra ?? 0;
    const meetsMin = adminUnits >= minRequired;

    const nick = u?.nick || `<@${userId}>`;

    return {
      userId,
      nick,
      adminUnits,
      extraRaw,
      meetsMin,
      adminPoints: 0,
      extraPoints: Math.min(30, extraRaw),
      total: Math.min(30, extraRaw),
      percentile: null
    };
  });

  const eligible = rows.filter(r => r.meetsMin);
  eligible.sort((a, b) => b.adminUnits - a.adminUnits);

  const n = eligible.length;

  for (let i = 0; i < n; i++) {
    const cur = eligible[i];
    let start = i;
    while (start > 0 && eligible[start - 1].adminUnits === cur.adminUnits) start--;

    const rank = start + 1;
    const pct = getTopPercentFromRank(rank, n);

    cur.percentile = pct;
    cur.adminPoints = getAdminPointsByPercentile(pct);
    cur.extraPoints = Math.min(30, cur.extraRaw);
    cur.total = Math.min(100, cur.adminPoints + cur.extraPoints);
  }

  const display = [...rows].sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    return b.adminUnits - a.adminUnits;
  });

  return { rows, display, dateStr };
}

function getDayTotalsOnly(rankName, dateStr) {
  const cacheKey = `${rankName}|${dateStr}`;
  const cached = dayTotalsCache.get(cacheKey);
  if (cached) return cached;

  const is소령 = rankName === '소령';
  const minRequired = is소령 ? 2 : 3;
  const group = is소령 ? data.소령 : data.중령;

  const rows = Object.entries(group.users || {}).map(([userId, u]) => {
    const adminUnits = u?.daily?.[dateStr]?.admin ?? 0;
    const extraRaw = u?.daily?.[dateStr]?.extra ?? 0;
    const meetsMin = adminUnits >= minRequired;
    return { userId, adminUnits, extraRaw, meetsMin };
  });

  const eligible = rows.filter(r => r.meetsMin);
  eligible.sort((a, b) => b.adminUnits - a.adminUnits);

  const n = eligible.length;
  const totalsMap = new Map();

  for (const r of rows) {
    const extraPoints = Math.min(30, r.extraRaw);
    totalsMap.set(r.userId, extraPoints);
  }

  for (let i = 0; i < n; i++) {
    const cur = eligible[i];

    let start = i;
    while (start > 0 && eligible[start - 1].adminUnits === cur.adminUnits) start--;

    const rank = start + 1;
    const pct = getTopPercentFromRank(rank, n);

    const adminPoints = getAdminPointsByPercentile(pct);
    const extraPoints = Math.min(30, cur.extraRaw);
    const total = Math.min(100, adminPoints + extraPoints);

    totalsMap.set(cur.userId, total);
  }

  dayTotalsCache.set(cacheKey, totalsMap);
  return totalsMap;
}

// ================== 임베드/페이지네이션 ==================
function buildPagerComponents(rankName, mode, key, page, totalPages) {
  const prevDisabled = page <= 0;
  const nextDisabled = page >= totalPages - 1;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pg|${rankName}|${mode}|${key}|${page - 1}`)
      .setLabel('이전 페이지')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(prevDisabled),
    new ButtonBuilder()
      .setCustomId(`pg|${rankName}|${mode}|${key}|${page + 1}`)
      .setLabel('다음 페이지')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(nextDisabled)
  );

  return [row];
}

function createDailyEmbedPaged(rankName, dateStr, fullList, page, pageSize, titlePrefix) {
  const total = fullList.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = clamp(page, 0, totalPages - 1);

  const start = p * pageSize;
  const slice = fullList.slice(start, start + pageSize);

  const lines = slice.length
    ? slice.map((r, i) => {
        const rankNo = start + i + 1;
        const minText = r.meetsMin ? '' : ' (최소업무 미달)';
        const pctText = r.percentile ? ` / 상위 ${r.percentile}%` : '';
        return `**${rankNo}위** ${r.nick} — **${r.total}점** 〔행정: ${r.adminPoints}${pctText} / 추가: ${r.extraPoints}${minText}〕`;
      }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} ${titlePrefix} (${dateStr}) (최대 100점)`)
    .setDescription(lines)
    .setFooter({ text: `페이지 ${p + 1}/${totalPages} · 소령 최소 2건 / 중령 최소 3건 미달 시 행정점수 0점, 추가점수는 그대로 반영` });
}

function createWeeklyEmbedPaged(rankName, weekStart, weekEnd, fullList, page, pageSize, titlePrefix) {
  const total = fullList.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = clamp(page, 0, totalPages - 1);

  const start = p * pageSize;
  const slice = fullList.slice(start, start + pageSize);

  const lines = slice.length
    ? slice.map((u, i) => {
        const rankNo = start + i + 1;
        return `**${rankNo}위** ${u.nick} — **${u.weeklyTotal}점**`;
      }).join('\n')
    : '데이터가 없습니다.';

  return new EmbedBuilder()
    .setTitle(`${rankName} ${titlePrefix}`)
    .setDescription(`**주간 범위(02시 기준)**: ${weekStart} 02:00 ~ ${addDays(weekEnd, 1)} 02:00\n\n${lines}`)
    .setFooter({ text: `페이지 ${p + 1}/${totalPages} · 주간=일~토(7일) 합산 / 최소업무 미달일도 추가점수는 반영` });
}

function createDemotionEmbed(list, page, pageSize, totalPages, title = '강등 대상 (주간 총합 120점 미만)', footerPrefix = '현재 주') {
  const start = page * pageSize;
  const slice = list.slice(start, start + pageSize);

  const lines = slice.length
    ? slice.map((x, i) => {
        const rankNo = start + i + 1;
        return `**${rankNo}위** ${x.mention} — **주간 ${x.totalScore}점** 〔${x.rankName}〕`;
      }).join('\n')
    : '대상이 없습니다.';

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines)
    .setFooter({ text: `페이지 ${page + 1}/${totalPages} · ${footerPrefix} 기준 · 가입 7일 미만 제외 / ${HR_ADMIN_ROLE_ID} 역할 보유자만 포함 / ${DEMOTION_EXCLUDED_ROLE_IDS.join(', ')} 역할 보유자 제외` });
}

function buildDemotionComponents(mode, key, page, totalPages) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`dg|${mode}|${key}|${page - 1}`)
        .setLabel('이전 페이지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page <= 0),
      new ButtonBuilder()
        .setCustomId(`dg|${mode}|${key}|${page + 1}`)
        .setLabel('다음 페이지')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page >= totalPages - 1)
    )
  ];
}

// ================== 자동 초기화 ==================
function pruneOldDaily(keepDays) {
  const cutoff = addDays(getReportDate(), -keepDays);

  const pruneUserDaily = (group) => {
    for (const u of Object.values(group.users || {})) {
      if (!u.daily) continue;
      for (const dateKey of Object.keys(u.daily)) {
        if (dateKey < cutoff) delete u.daily[dateKey];
      }
    }
  };

  pruneUserDaily(data.소령);
  pruneUserDaily(data.중령);

  for (const dateKey of Object.keys(data.소령.history.daily || {})) {
    if (dateKey < cutoff) delete data.소령.history.daily[dateKey];
  }
  for (const dateKey of Object.keys(data.중령.history.daily || {})) {
    if (dateKey < cutoff) delete data.중령.history.daily[dateKey];
  }

  dayTotalsCache.clear();
}

function pruneOldWeekly(keepWeeks) {
  const cutoff = addDays(getReportDate(), -(keepWeeks * 7));
  for (const k of Object.keys(data.소령.history.weekly || {})) {
    if (k < cutoff) delete data.소령.history.weekly[k];
  }
  for (const k of Object.keys(data.중령.history.weekly || {})) {
    if (k < cutoff) delete data.중령.history.weekly[k];
  }
}

function makeDailySnapshot(rankName, dateStr) {
  const group = rankName === '소령' ? data.소령 : data.중령;
  const ids = Object.keys(group.users || {});
  const { display } = buildDayScoresForMembers(rankName, dateStr, ids);
  return display.map(r => ({
    userId: r.userId,
    nick: r.nick,
    total: r.total,
    adminPoints: r.adminPoints,
    extraPoints: r.extraPoints,
    percentile: r.percentile,
    meetsMin: r.meetsMin
  }));
}

function makeWeeklySnapshot(rankName, weekStart) {
  const group = rankName === '소령' ? data.소령 : data.중령;

  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const totals = {};

  for (const [uid, u] of Object.entries(group.users || {})) {
    totals[uid] = { userId: uid, nick: u?.nick || `<@${uid}>`, weeklyTotal: 0 };
  }

  for (const d of weekDates) {
    const totalsMap = getDayTotalsOnly(rankName, d);
    for (const [uid, t] of totalsMap.entries()) {
      if (!totals[uid]) totals[uid] = { userId: uid, nick: group.users?.[uid]?.nick || `<@${uid}>`, weeklyTotal: 0 };
      totals[uid].weeklyTotal += t;
    }
  }

  const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
  return {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    list: list.map(x => ({ userId: x.userId, nick: x.nick, weeklyTotal: x.weeklyTotal }))
  };
}

function runDailyAutoReset() {
  const y = getYesterdayDate();
  data.소령.history.daily[y] = makeDailySnapshot('소령', y);
  data.중령.history.daily[y] = makeDailySnapshot('중령', y);

  pruneOldDaily(28);
  saveData();
  console.log(`🧹 어제 스냅샷 저장 완료 (${y})`);
}

function runWeeklyAutoReset() {
  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);
  const lastWeekStart = addDays(thisWeekStart, -7);

  data.소령.history.weekly[lastWeekStart] = makeWeeklySnapshot('소령', lastWeekStart);
  data.중령.history.weekly[lastWeekStart] = makeWeeklySnapshot('중령', lastWeekStart);

  data.소령.lastWeekStart = lastWeekStart;
  data.중령.lastWeekStart = lastWeekStart;

  data.소령.weekStart = thisWeekStart;
  data.중령.weekStart = thisWeekStart;

  pruneOldWeekly(16);
  saveData();
  console.log(`🔄 주간 초기화 완료 (weekStart=${thisWeekStart}, lastWeekStart=${lastWeekStart})`);
}

// ================== 강등 대상 계산 ==================
async function buildDemotionListForWeek(guild, weekStart) {
  const members = await guild.members.fetch();
  const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

  const eligible = [];
  for (const [, m] of members) {
    if (m.user?.bot) continue;

    const rankName = getRankNameForMember(m);
    if (!rankName) continue;

    if (!hasAnyRole(m, DEMOTION_REQUIRED_ROLE_IDS)) continue;
    if (hasAnyRole(m, DEMOTION_EXCLUDED_ROLE_IDS)) continue;
    if (daysSinceJoined(m) < 7) continue;

    eligible.push({ member: m, rankName });
  }

  const list = [];

  for (const { member, rankName } of eligible) {
    let totalScore = 0;

    for (const d of weekDates) {
      const dayTotals = getDayTotalsOnly(rankName, d);
      totalScore += (dayTotals.get(member.id) || 0);
    }

    if (totalScore < 120) {
      list.push({
        userId: member.id,
        mention: `<@${member.id}>`,
        rankName,
        totalScore
      });
    }
  }

  list.sort((a, b) => a.totalScore - b.totalScore);
  return list;
}

// ================== 명령어 등록 ==================
async function registerCommands() {
  console.log(`🔎 명령어 등록 대상 길드 ID: ${GUILD_ID}`);

  const guild = await client.guilds.fetch(GUILD_ID).catch((err) => {
    console.error('❌ 길드 조회 실패:', err?.message || err);
    return null;
  });

  if (!guild) {
    console.log('❌ 서버를 찾을 수 없습니다. 봇이 해당 길드에 초대되어 있는지, TOKEN이 이 봇의 토큰인지 확인하세요.');
    return;
  }

  console.log(`🔎 명령어 등록 대상 길드: ${guild.name} (${guild.id})`);

  const 소령Command = new SlashCommandBuilder()
    .setName('소령행정보고')
    .setDescription('소령 행정 보고서 (소령 역할 전용 / 02시~익일 02시 기준 하루 1회)')
    .addIntegerOption(o => o.setName('진급처리').setDescription('진급 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인증처리').setDescription('인증 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('행정처리').setDescription('행정 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('전역전출처리').setDescription('전역/전출 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('보직모집').setDescription('보직가입 요청 / 모집시험 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    소령Command.addAttachmentOption(o =>
      o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false)
    );
  }

  const 중령Command = new SlashCommandBuilder()
    .setName('중령행정보고')
    .setDescription('중령 행정 보고서 (중령 역할 전용 / 02시~익일 02시 기준 하루 1회)')
    .addIntegerOption(o => o.setName('진급처리').setDescription('진급 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인증처리').setDescription('인증 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('행정처리').setDescription('행정 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('전역전출처리').setDescription('전역/전출 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('보직모집').setDescription('보직가입 요청 / 모집시험 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 시험 : n건').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    중령Command.addAttachmentOption(o =>
      o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false)
    );
  }

  const 소령오늘초기화 = new SlashCommandBuilder()
    .setName('소령오늘초기화')
    .setDescription('소령 오늘 기록 초기화 - 특정 유저 또는 전체')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 유저를 오늘 기록 초기화').setRequired(false));

  const 중령오늘초기화 = new SlashCommandBuilder()
    .setName('중령오늘초기화')
    .setDescription('중령 오늘 기록 초기화 - 특정 유저 또는 전체')
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 유저를 오늘 기록 초기화').setRequired(false));

  try {
    await guild.commands.set([
    소령Command.toJSON(),
    중령Command.toJSON(),

    new SlashCommandBuilder().setName('소령오늘점수').setDescription('소령 오늘 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('중령오늘점수').setDescription('중령 오늘 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('소령이번주점수').setDescription('소령 이번 주 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('중령이번주점수').setDescription('중령 이번 주 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('소령어제점수').setDescription('소령 어제 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('중령어제점수').setDescription('중령 어제 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('소령지난주점수').setDescription('소령 지난주 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('중령지난주점수').setDescription('중령 지난주 점수 조회').toJSON(),

    new SlashCommandBuilder().setName('어제점수').setDescription('소령/중령 어제 점수 요약 안내').toJSON(),

    소령오늘초기화.toJSON(),
    중령오늘초기화.toJSON(),
    new SlashCommandBuilder().setName('초기화주간').setDescription('주간 전체 초기화').toJSON(),
    new SlashCommandBuilder().setName('행정통계').setDescription('전체 통계').toJSON(),

    new SlashCommandBuilder().setName('강등대상').setDescription('이번 주 주간 총합 120점 미만 강등 대상 조회').toJSON(),
    new SlashCommandBuilder().setName('지난주강등대상').setDescription('지난 주 주간 총합 120점 미만 강등 대상 조회').toJSON()
    ]);

    console.log('✅ 명령어 등록 완료');
  } catch (err) {
    console.error('❌ 명령어 등록 실패:', err?.rawError || err?.message || err);
    throw err;
  }
}

// ================== ready ==================
client.once('ready', async () => {
  console.log(`${client.user.tag} 준비 완료!`);
  loadData();

  const today = getReportDate();
  const thisWeekStart = getSundayWeekStart(today);

  if (!data.소령.weekStart) data.소령.weekStart = thisWeekStart;
  if (!data.중령.weekStart) data.중령.weekStart = thisWeekStart;
  saveData();

  if (!fs.existsSync(GOOGLE_KEYFILE)) {
    console.log(`⚠️ GOOGLE KEYFILE을 찾을 수 없습니다: ${GOOGLE_KEYFILE}`);
    console.log('   Railway Variables에 GOOGLE_SA_JSON을 추가했는지 확인하세요.');
  }

  await registerCommands();

  cron.schedule('0 2 * * *', () => runDailyAutoReset(), { timezone: 'Asia/Seoul' });
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(), { timezone: 'Asia/Seoul' });

  console.log('⏰ 자동 스냅샷/초기화 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

// ================== interactionCreate ==================
client.on('interactionCreate', async interaction => {
  // 버튼 처리
  if (interaction.isButton()) {
    const customId = interaction.customId || '';

    if (customId.startsWith('pg|')) {
      const isManager = () => interaction.member?.roles?.cache?.some(r => MANAGER_ROLE_IDS.includes(r.id));
      if (!isManager()) return interaction.reply({ content: '❌ 지정된 관리 역할만 사용할 수 있습니다.', ephemeral: true });

      const parts = customId.split('|');
      const rankName = parts[1];
      const mode = parts[2];
      const key = parts[3];
      const page = parseInt(parts[4], 10) || 0;

      const msgId = interaction.message?.id;
      const session = msgId ? paginationSessions.get(msgId) : null;

      if (!session || session.rankName !== rankName || session.mode !== mode || session.key !== key) {
        const guild = interaction.guild;
        if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

        const memberIds = await getEligibleMemberIdsByRank(guild, rankName);
        let newSession = null;

        if (mode === 'today' || mode === 'yesterday') {
          const dateStr = key;
          const { display } = buildDayScoresForMembers(rankName, dateStr, memberIds);
          newSession = { rankName, mode, key: dateStr, list: display, pageSize: 28 };
        } else if (mode === 'week' || mode === 'lastweek') {
          const weekStart = key;
          const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
          const group = rankName === '소령' ? data.소령 : data.중령;

          const totals = {};
          for (const uid of memberIds) {
            totals[uid] = {
              userId: uid,
              nick: group.users?.[uid]?.nick || `<@${uid}>`,
              weeklyTotal: 0
            };
          }

          for (const d of weekDates) {
            const totalsMap = getDayTotalsOnly(rankName, d);
            for (const uid of memberIds) totals[uid].weeklyTotal += (totalsMap.get(uid) || 0);
          }

          const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
          newSession = { rankName, mode, key: weekStart, list, pageSize: 28 };
        }

        if (!newSession) return interaction.reply({ content: '❌ 페이지 정보를 처리할 수 없습니다.', ephemeral: true });
        paginationSessions.set(msgId, newSession);
      }

      const s = paginationSessions.get(msgId);
      const pageSize = s.pageSize || 28;

      if (s.mode === 'today' || s.mode === 'yesterday') {
        const dateStr = s.key;
        const totalPages = Math.max(1, Math.ceil(s.list.length / pageSize));
        const p = clamp(page, 0, totalPages - 1);

        const titlePrefix = s.mode === 'today' ? '오늘 점수' : '어제 점수';
        const embed = createDailyEmbedPaged(rankName, dateStr, s.list, p, pageSize, titlePrefix);
        const components = buildPagerComponents(rankName, s.mode, s.key, p, totalPages);

        return interaction.update({ embeds: [embed], components });
      }

      if (s.mode === 'week' || s.mode === 'lastweek') {
        const weekStart = s.key;
        const weekEnd = addDays(weekStart, 6);

        const totalPages = Math.max(1, Math.ceil(s.list.length / pageSize));
        const p = clamp(page, 0, totalPages - 1);

        const titlePrefix = s.mode === 'week' ? '이번주 점수' : '지난주 점수';
        const embed = createWeeklyEmbedPaged(rankName, weekStart, weekEnd, s.list, p, pageSize, titlePrefix);
        const components = buildPagerComponents(rankName, s.mode, s.key, p, totalPages);

        return interaction.update({ embeds: [embed], components });
      }

      return;
    }

    if (customId.startsWith('dg|')) {
      const allowed = hasAnyRole(interaction.member, DEMOTION_ALLOWED_ROLE_IDS);
      if (!allowed) return interaction.reply({ content: '❌ 지정된 관리 역할만 사용할 수 있습니다.', ephemeral: true });

      const parts = customId.split('|');
      const mode = parts[1];
      const key = parts[2];
      const page = parseInt(parts[3], 10) || 0;

      const msgId = interaction.message?.id;
      const session = msgId ? paginationSessions.get(msgId) : null;

      if (!session || session.mode !== mode || session.key !== key) {
        return interaction.reply({ content: 'ℹ️ 페이지 세션이 만료되었습니다. 명령어를 다시 실행하세요.', ephemeral: true });
      }

      const pageSize = session.pageSize || 28;
      const list = session.list || [];
      const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
      const p = clamp(page, 0, totalPages - 1);

      const isLastWeek = mode === 'demotion_lastweek';
      const weekStart = key;
      const weekEnd = addDays(weekStart, 6);

      const embed = createDemotionEmbed(
        list,
        p,
        pageSize,
        totalPages,
        isLastWeek
          ? `지난주 강등 대상 (${weekStart} ~ ${weekEnd}, 주간 총합 120점 미만)`
          : `강등 대상 (${weekStart} ~ ${weekEnd}, 주간 총합 120점 미만)`,
        isLastWeek ? '지난 주' : '현재 주'
      );

      const components = buildDemotionComponents(mode, key, p, totalPages);

      return interaction.update({ embeds: [embed], components });
    }

    return;
  }

  // 슬래시
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  const hasRole = (roleId) => interaction.member?.roles?.cache?.has(roleId);
  const isManager = () => interaction.member?.roles?.cache?.some(r => MANAGER_ROLE_IDS.includes(r.id));
  const isMajor = () => hasRole(MAJOR_ROLE_ID);
  const isLtCol = () => hasRole(LTCOL_ROLE_ID);

  if (cmd === '소령행정보고') {
    if (!isMajor()) {
      return interaction.reply({
        content: `❌ 이 명령어는 **소령 역할**(<@&${MAJOR_ROLE_ID}>)만 사용할 수 있습니다.`,
        ephemeral: true
      });
    }
  }

  if (cmd === '중령행정보고') {
    if (!isLtCol()) {
      return interaction.reply({
        content: `❌ 이 명령어는 **중령 역할**(<@&${LTCOL_ROLE_ID}>)만 사용할 수 있습니다.`,
        ephemeral: true
      });
    }
  }

  // 그 외 명령어는 관리자 역할만 사용 가능
  if (cmd !== '소령행정보고' && cmd !== '중령행정보고') {
    if (!isManager()) {
      return interaction.reply({
        content: '❌ 지정된 관리 역할만 이 봇 명령어를 사용할 수 있습니다.',
        ephemeral: true
      });
    }
  }

  // ================== 행정보고 ==================
  if (cmd === '소령행정보고' || cmd === '중령행정보고') {
    const is소령 = cmd === '소령행정보고';
    const date = getReportDate();

    const mention = `<@${interaction.user.id}>`;
    const displayName = interaction.member?.displayName || interaction.user.username;

    const input = {
      진급처리: interaction.options.getInteger('진급처리'),
      인증처리: interaction.options.getInteger('인증처리'),
      행정처리: interaction.options.getInteger('행정처리'),
      전역전출처리: interaction.options.getInteger('전역전출처리'),
      보직모집: interaction.options.getInteger('보직모집'),
      인게임시험: interaction.options.getInteger('인게임시험')
    };

    const adminCount = calculateAdminUnits(input);
    const extra = calculateExtraPoints(input);

    const group = is소령 ? data.소령 : data.중령;
    if (!group.users[interaction.user.id]) {
      group.users[interaction.user.id] = {
        nick: displayName,
        totalAdmin: 0,
        totalExtra: 0,
        daily: {}
      };
    }

    const u = group.users[interaction.user.id];
    u.nick = displayName;

    // 02시~익일 02시 기준 하루 1회 제한
    if (u.daily[date]) {
      return interaction.reply({
        content:
          `❌ 오늘(${date}, 02:00 ~ 익일 02:00 기준)은 이미 **${is소령 ? '소령' : '중령'} 행정보고**를 완료했습니다.\n` +
          `기록을 다시 제출해야 하면 관리자 역할이 **/${is소령 ? '소령오늘초기화' : '중령오늘초기화'} 대상:@유저** 명령어로 초기화한 뒤 다시 보고해 주세요.`,
        ephemeral: true
      });
    }

    let replyText =
      `✅ **${is소령 ? '소령' : '중령'} 보고 완료!**\n` +
      `**닉네임**: ${mention}\n` +
      `**일자**: ${date}\n` +
      `**기준**: 02:00 ~ 익일 02:00 (하루 1회 제출)\n\n`;

    replyText += `**진급 처리**: ${input.진급처리}건\n`;
    replyText += `**인증 처리**: ${input.인증처리}건\n`;
    replyText += `**행정 처리**: ${input.행정처리}건\n`;
    replyText += `**전역/전출 처리**: ${input.전역전출처리}건\n`;
    replyText += `**보직가입 요청 / 모집시험**: ${input.보직모집}건\n`;
    replyText += `**인게임 시험**: ${input.인게임시험}건\n`;
    replyText += `**총 행정 건수**: ${adminCount}건\n`;

    const photoAttachments = [];
    for (let i = 1; i <= 10; i++) {
      const att = interaction.options.getAttachment(`증거사진${i}`);
      if (att) photoAttachments.push(att);
    }

    if (photoAttachments.length > 0) {
      replyText += `\n📸 증거 사진 ${photoAttachments.length}장 첨부됨`;
    } else {
      replyText += `\n⚠️ 증거 사진이 첨부되지 않았습니다.`;
    }

    u.daily[date] = {
      admin: adminCount,
      extra: extra
    };

    recomputeTotals(group);

    dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);
    saveData();

    // ================== 구글 시트 저장 ==================
    try {
      const range = is소령 ? '소령!A:I' : '중령!A:I';
      await appendRowToSheet(range, [
        date,
        displayName,
        input.진급처리,
        input.인증처리,
        input.행정처리,
        input.전역전출처리,
        adminCount,
        input.보직모집,
        input.인게임시험
      ]);
    } catch (e) {
      console.error('❌ 구글시트 저장 실패:', e?.response?.data || e);
      replyText += `\n\n⚠️ 구글 시트 자동 기입에 실패했습니다. Railway Logs를 확인하세요.`;
    }

    let files = [];

    if (photoAttachments.length > 0) {
      files = photoAttachments.slice(0, 10).map((att, idx) => ({
        attachment: att.url,
        name: `evidence_${idx + 1}_${att.name || `image_${idx + 1}.png`}`
      }));
    }

    await interaction.reply({
      content: replyText,
      files,
      ephemeral: false
    });
    return;
  }

  const guild = interaction.guild;

  async function replyDailyPaged(rankName, dateStr, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const memberIds = await getEligibleMemberIdsByRank(guild, rankName);
    const { display } = buildDayScoresForMembers(rankName, dateStr, memberIds);

    const pageSize = 28;
    const page = 0;
    const totalPages = Math.max(1, Math.ceil(display.length / pageSize));

    const titlePrefix = mode === 'today' ? '오늘 점수' : mode === 'yesterday' ? '어제 점수' : '점수';
    const embed = createDailyEmbedPaged(rankName, dateStr, display, page, pageSize, titlePrefix);
    const components = buildPagerComponents(rankName, mode, dateStr, page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { rankName, mode, key: dateStr, list: display, pageSize });
  }

  async function replyWeeklyPaged(rankName, weekStart, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const memberIds = await getEligibleMemberIdsByRank(guild, rankName);

    const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    const weekEnd = addDays(weekStart, 6);

    const group = rankName === '소령' ? data.소령 : data.중령;

    const totals = {};
    for (const uid of memberIds) {
      totals[uid] = {
        userId: uid,
        nick: group.users?.[uid]?.nick || `<@${uid}>`,
        weeklyTotal: 0
      };
    }

    for (const d of weekDates) {
      const totalsMap = getDayTotalsOnly(rankName, d);
      for (const uid of memberIds) totals[uid].weeklyTotal += (totalsMap.get(uid) || 0);
    }

    const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);

    const pageSize = 28;
    const page = 0;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));

    const titlePrefix = mode === 'week' ? '이번주 점수' : '지난주 점수';
    const embed = createWeeklyEmbedPaged(rankName, weekStart, weekEnd, list, page, pageSize, titlePrefix);
    const components = buildPagerComponents(rankName, mode, weekStart, page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { rankName, mode, key: weekStart, list, pageSize });
  }

  async function replyDemotionPaged(weekStart, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });

    const list = await buildDemotionListForWeek(guild, weekStart);
    const pageSize = 28;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    const page = 0;
    const weekEnd = addDays(weekStart, 6);
    const isLastWeek = mode === 'demotion_lastweek';

    const embed = createDemotionEmbed(
      list,
      page,
      pageSize,
      totalPages,
      isLastWeek
        ? `지난주 강등 대상 (${weekStart} ~ ${weekEnd}, 주간 총합 120점 미만)`
        : `강등 대상 (${weekStart} ~ ${weekEnd}, 주간 총합 120점 미만)`,
      isLastWeek ? '지난 주' : '현재 주'
    );

    const components = buildDemotionComponents(mode, weekStart, page, totalPages);

    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { mode, key: weekStart, list, pageSize });
  }

  if (cmd === '소령오늘점수') return replyDailyPaged('소령', getReportDate(), 'today');
  if (cmd === '중령오늘점수') return replyDailyPaged('중령', getReportDate(), 'today');

  if (cmd === '소령이번주점수') {
    const weekStart = data.소령.weekStart || getSundayWeekStart(getReportDate());
    return replyWeeklyPaged('소령', weekStart, 'week');
  }
  if (cmd === '중령이번주점수') {
    const weekStart = data.중령.weekStart || getSundayWeekStart(getReportDate());
    return replyWeeklyPaged('중령', weekStart, 'week');
  }

  if (cmd === '소령어제점수') return replyDailyPaged('소령', getYesterdayDate(), 'yesterday');
  if (cmd === '중령어제점수') return replyDailyPaged('중령', getYesterdayDate(), 'yesterday');

  if (cmd === '소령지난주점수') {
    const thisWeekStart = data.소령.weekStart || getSundayWeekStart(getReportDate());
    const lastWeekStart = data.소령.lastWeekStart || addDays(thisWeekStart, -7);
    return replyWeeklyPaged('소령', lastWeekStart, 'lastweek');
  }
  if (cmd === '중령지난주점수') {
    const thisWeekStart = data.중령.weekStart || getSundayWeekStart(getReportDate());
    const lastWeekStart = data.중령.lastWeekStart || addDays(thisWeekStart, -7);
    return replyWeeklyPaged('중령', lastWeekStart, 'lastweek');
  }

  if (cmd === '강등대상') {
    const allowed = hasAnyRole(interaction.member, DEMOTION_ALLOWED_ROLE_IDS);
    if (!allowed) return interaction.reply({ content: '❌ 지정된 관리 역할만 사용할 수 있습니다.', ephemeral: true });

    const currentWeekStart = getSundayWeekStart(getReportDate());
    return replyDemotionPaged(currentWeekStart, 'demotion_current');
  }

  if (cmd === '지난주강등대상') {
    const allowed = hasAnyRole(interaction.member, DEMOTION_ALLOWED_ROLE_IDS);
    if (!allowed) return interaction.reply({ content: '❌ 지정된 관리 역할만 사용할 수 있습니다.', ephemeral: true });

    const thisWeekStart = getSundayWeekStart(getReportDate());
    const lastWeekStart = addDays(thisWeekStart, -7);
    return replyDemotionPaged(lastWeekStart, 'demotion_lastweek');
  }

  if (cmd === '어제점수') {
    const dateStr = getYesterdayDate();
    const embed = new EmbedBuilder()
      .setTitle(`어제 점수 (기준일: ${dateStr})`)
      .setDescription('※ 공용 명령은 현재 “요약 안내”만 유지 중입니다.');
    return interaction.reply({ embeds: [embed] });
  }

  if (cmd === '초기화주간') {
    const majRes = clearPrev7ReportDaysBeforeThisWeek(data.소령);
    const ltRes = clearPrev7ReportDaysBeforeThisWeek(data.중령);

    data.소령.weekStart = majRes.thisWeekStart;
    data.중령.weekStart = ltRes.thisWeekStart;

    pruneOldDaily(28);
    pruneOldWeekly(16);

    dayTotalsCache.clear();
    paginationSessions.clear();
    saveData();

    const endShown = addDays(majRes.rangeEnd, -1);

    return interaction.reply({
      content:
        `🔄 주간 초기화 완료 (일요일 02시 기준)\n` +
        `- 오늘(reportDate): ${majRes.today}\n` +
        `- 보호(이번 주): ${majRes.thisWeekStart} 02:00 이후 ~ 현재\n` +
        `- 삭제 구간(reportDate 7일): ${majRes.rangeStart} ~ ${endShown}\n` +
        `- 삭제된 daily 항목 수: 소령 ${majRes.clearedEntries} / 중령 ${ltRes.clearedEntries}\n` +
        `※ 일요일 02:00 이전(00:00~01:59) 보고는 reportDate가 전날로 저장되어 위 삭제 구간에 포함되어 삭제됩니다.`,
      ephemeral: false
    });
  }

  if (cmd === '소령오늘초기화' || cmd === '중령오늘초기화') {
    const is소령 = cmd === '소령오늘초기화';
    const date = getReportDate();
    const group = is소령 ? data.소령 : data.중령;

    const targetUser = interaction.options.getUser('대상');
    const isAll = interaction.options.getBoolean('전체') === true;

    if (!isAll && !targetUser) {
      return interaction.reply({ content: 'ℹ️ 대상 또는 전체(true)를 선택하세요.', ephemeral: true });
    }

    let cleared = 0;

    if (isAll) {
      for (const uid of Object.keys(group.users || {})) {
        const u = group.users[uid];
        if (u?.daily?.[date]) {
          delete u.daily[date];
          cleared++;
        }
      }

      recomputeTotals(group);
      dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);
      paginationSessions.clear();
      saveData();

      return interaction.reply({
        content:
          `✅ 오늘(${date}) 기록 전체 초기화 완료 (${cleared}명)\n` +
          `이제 해당 인원들은 ${is소령 ? '/소령행정보고' : '/중령행정보고'}를 다시 사용할 수 있습니다.`,
        ephemeral: false
      });
    }

    const uid = targetUser.id;
    const u = group.users?.[uid];
    if (!u?.daily?.[date]) {
      return interaction.reply({ content: `ℹ️ ${targetUser} 님은 오늘(${date}) 기록이 없습니다.`, ephemeral: true });
    }

    delete u.daily[date];
    recomputeTotals(group);

    dayTotalsCache.delete(`${is소령 ? '소령' : '중령'}|${date}`);
    paginationSessions.clear();
    saveData();

    return interaction.reply({
      content:
        `✅ ${targetUser} 님의 오늘(${date}) 기록을 초기화했습니다.\n` +
        `이제 ${targetUser} 님은 ${is소령 ? '/소령행정보고' : '/중령행정보고'}를 다시 사용할 수 있습니다.`,
      ephemeral: false
    });
  }

  if (cmd === '행정통계') {
    const date = getReportDate();

    const sumGroup = (group) => {
      let userCount = 0;
      let totalAdmin = 0;
      let totalExtra = 0;
      let todayAdminUnits = 0;
      let todayExtra = 0;

      for (const u of Object.values(group.users || {})) {
        userCount++;
        totalAdmin += (u.totalAdmin || 0);
        totalExtra += (u.totalExtra || 0);

        const d = u.daily?.[date];
        if (d) {
          todayAdminUnits += (d.admin || 0);
          todayExtra += (d.extra || 0);
        }
      }
      return { userCount, totalAdmin, totalExtra, todayAdminUnits, todayExtra };
    };

    const sMaj = sumGroup(data.소령);
    const sLt = sumGroup(data.중령);

    const embed = new EmbedBuilder()
      .setTitle('행정 통계(원자료)')
      .setDescription(
        `**기준 일자(02시~익일 02시 기준)**: ${date}\n\n` +
        `## 소령\n` +
        `- 등록 인원: ${sMaj.userCount}명\n` +
        `- 누적(원자료): 행정(건수) ${sMaj.totalAdmin} / 추가(점수) ${sMaj.totalExtra}\n` +
        `- 오늘(원자료): 행정(건수) ${sMaj.todayAdminUnits} / 추가(점수) ${sMaj.todayExtra}\n\n` +
        `## 중령\n` +
        `- 등록 인원: ${sLt.userCount}명\n` +
        `- 누적(원자료): 행정(건수) ${sLt.totalAdmin} / 추가(점수) ${sLt.totalExtra}\n` +
        `- 오늘(원자료): 행정(건수) ${sLt.todayAdminUnits} / 추가(점수) ${sLt.todayExtra}\n\n` +
        `※ 소령 최소업무 2건 / 중령 최소업무 3건 미달이어도 추가점수는 점수 합산에 반영됩니다.\n` +
        `※ 행정보고는 02시~익일 02시 기준 하루 1회만 제출 가능합니다.`
      );

    return interaction.reply({ embeds: [embed] });
  }
});

// ================== TOKEN 체크 ==================
if (!TOKEN) {
  console.log('❌ TOKEN이 설정되지 않았습니다! Railway Variables의 TOKEN 확인');
  process.exit(1);
}

process.on('SIGTERM', () => {
  console.log('ℹ️ SIGTERM received. Railway가 프로세스를 종료했습니다.');
});

startHealthServer();
client.login(TOKEN).catch((err) => {
  console.error('❌ Discord 로그인 실패:', err);
  process.exit(1);
});


