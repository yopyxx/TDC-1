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
const path = require('path');
const { google } = require('googleapis');

// ================== 설정 ==================
const TOKEN = process.env.TOKEN;
const GUILD_ID = '1486229581190004748';

// ✅ 진급 스프레드시트 ID
const SPREADSHEET_ID = '14XoO78o6PiSQe8FIIBt_OYbbV4frozS5WBviSSSzRBg';

// ================== Railway용: 서비스계정 JSON을 env로 받아 파일로 생성 ==================
function ensureGoogleKeyFile() {
  const envJson = process.env.GOOGLE_SA_JSON;
  const filePath = process.env.GOOGLE_KEYFILE || path.join(__dirname, 'service-account.json');

  if (fs.existsSync(filePath)) return filePath;

  if (!envJson) {
    console.log('❌ GOOGLE_SA_JSON 환경변수가 없고, service-account.json 파일도 없습니다.');
    return filePath;
  }

  try {
    const parsed = JSON.parse(envJson);
    if (parsed.private_key) {
      parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
    }
    fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf8');
    console.log(`✅ Google service account key written to: ${filePath}`);
    return filePath;
  } catch (err) {
    console.error('❌ GOOGLE_SA_JSON 파싱 실패:', err);
    throw err;
  }
}

const GOOGLE_KEYFILE = ensureGoogleKeyFile();

// ✅ 구글 인증
const gAuth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_KEYFILE,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

async function appendRowToSheet(rangeA1, values) {
  const sheets = google.sheets({ version: 'v4', auth: gAuth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: rangeA1,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [values] }
  });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// ================== 역할 ID ==================
const ALL_COMMAND_MANAGER_ROLE_ID = '1489255441492869170'; // 모든 관리 명령어 사용 가능
const HR_ADMIN_ROLE_ID = '1486229581584142437';           // /강등대상 포함 대상 역할
const DEMOTION_EXCLUDED_ROLE_ID = '1486229581190004752';  // /강등대상 제외 역할
const MAJOR_ROLE_ID = '1486229581190004753';              // 소령
const LTCOL_ROLE_ID = '1486229581190004754';              // 중령

const MANAGER_ROLE_IDS = [ALL_COMMAND_MANAGER_ROLE_ID];

const SCORE_INCLUDED_ROLE_IDS = {
  소령: MAJOR_ROLE_ID,
  중령: LTCOL_ROLE_ID
};

const DEMOTION_REQUIRED_ROLE_IDS = [HR_ADMIN_ROLE_ID];
const DEMOTION_ALLOWED_ROLE_IDS = [ALL_COMMAND_MANAGER_ROLE_ID];

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'admin_data.json');

// ================== 데이터 구조 ==================
let data = {
  소령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' },
  중령: { weekStart: '', users: {}, history: { daily: {}, weekly: {} }, lastWeekStart: '' }
};

// ================== 런타임 캐시 ==================
const dayTotalsCache = new Map();
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
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000);
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
  const day = d.getUTCDay();
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
// 행정 건수 계산
// 랭크변경 x1, 인증 x1, 행정요청 x1, 그룹랭크요청 ÷2, 서버역할요청 ÷2
function calculateAdminUnits(input) {
  return (
    (input.랭크변경 || 0) * 1 +
    (input.인증 || 0) * 1 +
    (input.행정요청 || 0) * 1 +
    Math.floor((input.그룹랭크요청 || 0) / 2) +
    Math.floor((input.서버역할요청 || 0) / 2)
  );
}

// 추가점수 계산 (보직모집/모집시험: 인당 2점, 인게임시험: 1점, 최대 30점)
function calculateExtraPoints(input) {
  return (
    (input.보직모집 || 0) * 2 +
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
    totalsMap.set(r.userId, Math.min(30, r.extraRaw));
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
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`pg|${rankName}|${mode}|${key}|${page - 1}`)
      .setLabel('이전 페이지')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page <= 0),
    new ButtonBuilder()
      .setCustomId(`pg|${rankName}|${mode}|${key}|${page + 1}`)
      .setLabel('다음 페이지')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(page >= totalPages - 1)
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

function createDemotionEmbed(list, page, pageSize, totalPages, title, footerPrefix) {
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
    .setFooter({ text: `페이지 ${page + 1}/${totalPages} · ${footerPrefix} 기준 · 가입 7일 미만 제외 / ${HR_ADMIN_ROLE_ID} 역할 보유자만 포함 / ${DEMOTION_EXCLUDED_ROLE_ID} 역할 보유자 제외` });
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
    if (m.roles.cache.has(DEMOTION_EXCLUDED_ROLE_ID)) continue;
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
  const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
  if (!guild) return console.log('서버를 찾을 수 없습니다.');

  // ✅ 통합 행정보고 명령어
  const 행정보고Command = new SlashCommandBuilder()
    .setName('행정보고')
    .setDescription('인사교육단 행정 보고서 (소령/중령 역할 전용 / 02시~익일 02시 기준 하루 1회)')
    .addIntegerOption(o => o.setName('랭크변경').setDescription('랭크 변경 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인증').setDescription('인증 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('행정요청').setDescription('행정 요청 처리 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('그룹랭크요청').setDescription('그룹 랭크 요청 처리 : n건 (2건 = 랭크변경 1건)').setRequired(true))
    .addIntegerOption(o => o.setName('서버역할요청').setDescription('서버 역할 요청 처리 : n건 (2건 = 랭크변경 1건)').setRequired(true))
    .addIntegerOption(o => o.setName('보직모집').setDescription('보직가입 요청 / 모집시험 : n건').setRequired(true))
    .addIntegerOption(o => o.setName('인게임시험').setDescription('인게임 비사령부 시험 : n건').setRequired(true));

  for (let i = 1; i <= 10; i++) {
    행정보고Command.addAttachmentOption(o =>
      o.setName(`증거사진${i}`).setDescription(`증거 사진 ${i}`).setRequired(false)
    );
  }

  // ✅ 오늘초기화 (통합)
  const 오늘초기화Command = new SlashCommandBuilder()
    .setName('오늘초기화')
    .setDescription('오늘 행정보고 기록 초기화 - 특정 유저 또는 전체 (소령/중령 선택)')
    .addStringOption(o =>
      o.setName('계급').setDescription('초기화할 계급').setRequired(true)
        .addChoices({ name: '소령', value: '소령' }, { name: '중령', value: '중령' })
    )
    .addUserOption(o => o.setName('대상').setDescription('초기화할 대상 유저(선택)').setRequired(false))
    .addBooleanOption(o => o.setName('전체').setDescription('전체 유저를 오늘 기록 초기화').setRequired(false));

  await guild.commands.set([
    행정보고Command.toJSON(),

    new SlashCommandBuilder().setName('소령오늘점수').setDescription('소령 오늘 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('중령오늘점수').setDescription('중령 오늘 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('소령이번주점수').setDescription('소령 이번 주 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('중령이번주점수').setDescription('중령 이번 주 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('소령어제점수').setDescription('소령 어제 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('중령어제점수').setDescription('중령 어제 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('소령지난주점수').setDescription('소령 지난주 점수 조회').toJSON(),
    new SlashCommandBuilder().setName('중령지난주점수').setDescription('중령 지난주 점수 조회').toJSON(),

    new SlashCommandBuilder().setName('어제점수').setDescription('소령/중령 어제 점수 요약 안내').toJSON(),

    오늘초기화Command.toJSON(),
    new SlashCommandBuilder().setName('초기화주간').setDescription('주간 전체 초기화').toJSON(),
    new SlashCommandBuilder().setName('행정통계').setDescription('전체 통계').toJSON(),

    new SlashCommandBuilder().setName('강등대상').setDescription('이번 주 주간 총합 120점 미만 강등 대상 조회').toJSON(),
    new SlashCommandBuilder().setName('지난주강등대상').setDescription('지난 주 주간 총합 120점 미만 강등 대상 조회').toJSON()
  ]);

  console.log('✅ 명령어 등록 완료');
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
  }

  await registerCommands();

  cron.schedule('0 2 * * *', () => runDailyAutoReset(), { timezone: 'Asia/Seoul' });
  cron.schedule('0 2 * * 0', () => runWeeklyAutoReset(), { timezone: 'Asia/Seoul' });

  console.log('⏰ 자동 스냅샷/초기화 스케줄 등록 완료 (매일 02:00 / 매주 일 02:00)');
});

// ================== interactionCreate ==================
client.on('interactionCreate', async interaction => {

  // ================== 버튼 처리 ==================
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
            totals[uid] = { userId: uid, nick: group.users?.[uid]?.nick || `<@${uid}>`, weeklyTotal: 0 };
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
        list, p, pageSize, totalPages,
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

  // ================== 슬래시 명령어 ==================
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  const hasRole = (roleId) => interaction.member?.roles?.cache?.has(roleId);
  const isManager = () => interaction.member?.roles?.cache?.some(r => MANAGER_ROLE_IDS.includes(r.id));
  const isMajor = () => hasRole(MAJOR_ROLE_ID);
  const isLtCol = () => hasRole(LTCOL_ROLE_ID);

  // ================== /행정보고 (통합) ==================
  if (cmd === '행정보고') {
    // 소령 또는 중령 역할 확인
    if (!isMajor() && !isLtCol()) {
      return interaction.reply({
        content: '❌ 이 명령어는 **소령**(<@&1486229581190004753>) 또는 **중령**(<@&1486229581190004754>) 역할만 사용할 수 있습니다.',
        ephemeral: true
      });
    }

    // 소령/중령 자동 판별 (중령 우선)
    const rankName = isLtCol() ? '중령' : '소령';
    const date = getReportDate();
    const mention = `<@${interaction.user.id}>`;
    const displayName = interaction.member?.displayName || interaction.user.username;

    const input = {
      랭크변경: interaction.options.getInteger('랭크변경'),
      인증: interaction.options.getInteger('인증'),
      행정요청: interaction.options.getInteger('행정요청'),
      그룹랭크요청: interaction.options.getInteger('그룹랭크요청'),
      서버역할요청: interaction.options.getInteger('서버역할요청'),
      보직모집: interaction.options.getInteger('보직모집'),
      인게임시험: interaction.options.getInteger('인게임시험')
    };

    // 행정 건수 계산 (그룹랭크요청, 서버역할요청은 2건당 1건으로 치환)
    const adminCount = calculateAdminUnits(input);
    const extra = calculateExtraPoints(input);

    const group = rankName === '소령' ? data.소령 : data.중령;

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

    // 하루 1회 제한
    if (u.daily[date]) {
      return interaction.reply({
        content:
          `❌ 오늘(${date}, 02:00 ~ 익일 02:00 기준)은 이미 **${rankName} 행정보고**를 완료했습니다.\n` +
          `기록을 다시 제출해야 하면 관리자 역할이 **/오늘초기화 계급:${rankName} 대상:@유저** 명령어로 초기화한 뒤 다시 보고해 주세요.`,
        ephemeral: true
      });
    }

    // 그룹랭크요청, 서버역할요청 치환 계산 안내
    const groupRankConverted = Math.floor(input.그룹랭크요청 / 2);
    const serverRoleConverted = Math.floor(input.서버역할요청 / 2);

    let replyText =
      `✅ **인사교육단 ${rankName} 보고 완료!**\n` +
      `**닉네임**: ${mention}\n` +
      `**일자**: ${date}\n` +
      `**기준**: 02:00 ~ 익일 02:00 (하루 1회 제출)\n\n`;

    replyText += `**랭크 변경**: ${input.랭크변경}건\n`;
    replyText += `**인증**: ${input.인증}건\n`;
    replyText += `**행정 요청**: ${input.행정요청}건\n`;
    replyText += `**그룹 랭크 요청**: ${input.그룹랭크요청}건 → 랭크변경 ${groupRankConverted}건으로 치환\n`;
    replyText += `**서버 역할 요청**: ${input.서버역할요청}건 → 랭크변경 ${serverRoleConverted}건으로 치환\n`;
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

    u.daily[date] = { admin: adminCount, extra: extra };
    recomputeTotals(group);
    dayTotalsCache.delete(`${rankName}|${date}`);
    saveData();

    // ================== 구글 시트 저장 ==================
    // 컬럼: A날짜 B닉네임 C랭크변경 D인증 E행정요청 F그룹랭크요청 G서버역할요청 H총행정건수 I보직모집 J인게임시험
    try {
      const range = rankName === '소령' ? '소령!A:J' : '중령!A:J';
      await appendRowToSheet(range, [
        date,
        displayName,
        input.랭크변경,
        input.인증,
        input.행정요청,
        input.그룹랭크요청,
        input.서버역할요청,
        adminCount,
        input.보직모집,
        input.인게임시험
      ]);
    } catch (e) {
      console.error('❌ 구글시트 저장 실패:', e);
      replyText += `\n\n⚠️ 구글 시트 자동 기입에 실패했습니다. Railway Logs를 확인하세요.`;
    }

    // 증거사진 처리
    let files = [];
    if (photoAttachments.length > 0) {
      files = photoAttachments.slice(0, 10).map((att, idx) => ({
        attachment: att.url,
        name: `evidence_${idx + 1}_${att.name || `image_${idx + 1}.png`}`
      }));
    }

    await interaction.reply({ content: replyText, files, ephemeral: false });
    return;
  }

  // ================== 그 외 명령어는 관리자 역할만 ==================
  if (!isManager()) {
    return interaction.reply({
      content: '❌ 지정된 관리 역할만 이 봇 명령어를 사용할 수 있습니다.',
      ephemeral: true
    });
  }

  const guild = interaction.guild;

  async function replyDailyPaged(rankName, dateStr, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });
    const memberIds = await getEligibleMemberIdsByRank(guild, rankName);
    const { display } = buildDayScoresForMembers(rankName, dateStr, memberIds);
    const pageSize = 28;
    const totalPages = Math.max(1, Math.ceil(display.length / pageSize));
    const titlePrefix = mode === 'today' ? '오늘 점수' : mode === 'yesterday' ? '어제 점수' : '점수';
    const embed = createDailyEmbedPaged(rankName, dateStr, display, 0, pageSize, titlePrefix);
    const components = buildPagerComponents(rankName, mode, dateStr, 0, totalPages);
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
      totals[uid] = { userId: uid, nick: group.users?.[uid]?.nick || `<@${uid}>`, weeklyTotal: 0 };
    }
    for (const d of weekDates) {
      const totalsMap = getDayTotalsOnly(rankName, d);
      for (const uid of memberIds) totals[uid].weeklyTotal += (totalsMap.get(uid) || 0);
    }

    const list = Object.values(totals).sort((a, b) => b.weeklyTotal - a.weeklyTotal);
    const pageSize = 28;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    const titlePrefix = mode === 'week' ? '이번주 점수' : '지난주 점수';
    const embed = createWeeklyEmbedPaged(rankName, weekStart, weekEnd, list, 0, pageSize, titlePrefix);
    const components = buildPagerComponents(rankName, mode, weekStart, 0, totalPages);
    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { rankName, mode, key: weekStart, list, pageSize });
  }

  async function replyDemotionPaged(weekStart, mode) {
    if (!guild) return interaction.reply({ content: '❌ 서버 정보를 찾을 수 없습니다.', ephemeral: true });
    const list = await buildDemotionListForWeek(guild, weekStart);
    const pageSize = 28;
    const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
    const weekEnd = addDays(weekStart, 6);
    const isLastWeek = mode === 'demotion_lastweek';

    const embed = createDemotionEmbed(
      list, 0, pageSize, totalPages,
      isLastWeek
        ? `지난주 강등 대상 (${weekStart} ~ ${weekEnd}, 주간 총합 120점 미만)`
        : `강등 대상 (${weekStart} ~ ${weekEnd}, 주간 총합 120점 미만)`,
      isLastWeek ? '지난 주' : '현재 주'
    );

    const components = buildDemotionComponents(mode, weekStart, 0, totalPages);
    const msg = await interaction.reply({ embeds: [embed], components, fetchReply: true });
    paginationSessions.set(msg.id, { mode, key: weekStart, list, pageSize });
  }

  // ================== 점수 조회 ==================
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

  // ================== 강등 대상 ==================
  if (cmd === '강등대상') {
    const currentWeekStart = getSundayWeekStart(getReportDate());
    return replyDemotionPaged(currentWeekStart, 'demotion_current');
  }

  if (cmd === '지난주강등대상') {
    const thisWeekStart = getSundayWeekStart(getReportDate());
    const lastWeekStart = addDays(thisWeekStart, -7);
    return replyDemotionPaged(lastWeekStart, 'demotion_lastweek');
  }

  // ================== 어제점수 요약 ==================
  if (cmd === '어제점수') {
    const dateStr = getYesterdayDate();
    const embed = new EmbedBuilder()
      .setTitle(`어제 점수 (기준일: ${dateStr})`)
      .setDescription('※ 소령/중령 어제점수는 각각 /소령어제점수, /중령어제점수 명령어를 사용해주세요.');
    return interaction.reply({ embeds: [embed] });
  }

  // ================== 초기화주간 ==================
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

  // ================== 오늘초기화 (통합) ==================
  if (cmd === '오늘초기화') {
    const rankName = interaction.options.getString('계급');
    const date = getReportDate();
    const group = rankName === '소령' ? data.소령 : data.중령;

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
      dayTotalsCache.delete(`${rankName}|${date}`);
      paginationSessions.clear();
      saveData();

      return interaction.reply({
        content:
          `✅ ${rankName} 오늘(${date}) 기록 전체 초기화 완료 (${cleared}명)\n` +
          `이제 해당 인원들은 /행정보고를 다시 사용할 수 있습니다.`,
        ephemeral: false
      });
    }

    const uid = targetUser.id;
    const u = group.users?.[uid];
    if (!u?.daily?.[date]) {
      return interaction.reply({ content: `ℹ️ ${targetUser} 님은 오늘(${date}) ${rankName} 기록이 없습니다.`, ephemeral: true });
    }

    delete u.daily[date];
    recomputeTotals(group);
    dayTotalsCache.delete(`${rankName}|${date}`);
    paginationSessions.clear();
    saveData();

    return interaction.reply({
      content:
        `✅ ${targetUser} 님의 오늘(${date}) ${rankName} 기록을 초기화했습니다.\n` +
        `이제 ${targetUser} 님은 /행정보고를 다시 사용할 수 있습니다.`,
      ephemeral: false
    });
  }

  // ================== 행정통계 ==================
  if (cmd === '행정통계') {
    const date = getReportDate();

    const sumGroup = (group) => {
      let userCount = 0, totalAdmin = 0, totalExtra = 0, todayAdminUnits = 0, todayExtra = 0;
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
      .setTitle('인사교육단 행정 통계')
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

client.login(TOKEN);

/*
================== 최종 반영 사항 ==================

1) 역할 ID
- 소령: 1486229581190004753
- 중령: 1486229581190004754
- 강등대상 포함 역할: 1486229581584142437
- 강등대상 제외 역할: 1486229581190004752
- 모든 관리 명령어 사용 가능 역할: 1489255441492869170

2) 행정보고 통합
- /소령행정보고 + /중령행정보고 → /행정보고 하나로 통합
- 봇이 역할 자동 판별 (중령 우선)

3) 행정 업무 입력 항목
- 랭크변경 (x1)
- 인증 (x1)
- 행정요청 (x1)
- 그룹랭크요청 (2건 = 랭크변경 1건으로 치환)
- 서버역할요청 (2건 = 랭크변경 1건으로 치환)
- 보직모집 (추가점수 인당 2점)
- 인게임시험 (추가점수 1점)

4) 추가점수 계산
- 보직모집 = 2점
- 인게임시험 = 1점
- 추가점수 최대 30점

5) 최소업무 미달 처리
- 소령 2 미만이면 행정점수 0점
- 중령 3 미만이면 행정점수 0점
- 추가점수는 그대로 반영

6) 점수 배점
- 상위 10%: 70점
- 상위 34%: 50점
- 상위 66%: 40점
- 상위 90%: 30점
- 하위 10%: 20점

7) 구글 시트 저장 형식 (소령/중령 동일)
A 날짜
B 닉네임
C 랭크변경
D 인증
E 행정요청
F 그룹랭크요청
G 서버역할요청
H 총 행정 건수
I 보직모집
J 인게임시험

8) 점수 조회 명령어 (소령/중령 따로 유지)
- /소령오늘점수, /소령어제점수, /소령이번주점수, /소령지난주점수
- /중령오늘점수, /중령어제점수, /중령이번주점수, /중령지난주점수

9) 오늘초기화 통합
- /소령오늘초기화 + /중령오늘초기화 → /오늘초기화 (계급 선택)

10) 명칭 변경
- 인사행정단 → 인사교육단
- 훈련개최 → 인게임시험
*/
