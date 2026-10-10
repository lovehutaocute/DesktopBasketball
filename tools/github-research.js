/**
 * GitHub 调研脚本 —— 为目标项目（桌面物理球 / 桌面宠物 / 物理模拟球类）检索可比开源实现。
 * 输出：仓库名 / star / license / 语言 / 简介 / 最后更新
 * 用法: node tools/github-research.js
 */
const QUERIES = [
  'desktop pet physics transparent window',
  'desktop ball physics',
  'bouncing ball desktop windows',
  'shimeji desktop mascot',
  'matter.js physics ball',
  'wallpaper engine WorkerW desktop layer',
  'desktop mascot electron transparent always on top',
  'box2d windows desktop overlay physics',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gh(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'desktop-basketball-research', Accept: 'application/vnd.github+json' },
      });
      if (res.status === 403 || res.status === 429) {
        await sleep(8000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === 3) throw e;
      await sleep(3000);
    }
  }
}

(async () => {
  const seen = new Map();
  for (const q of QUERIES) {
    const url =
      'https://api.github.com/search/repositories?q=' +
      encodeURIComponent(q) +
      '&sort=stars&order=desc&per_page=8';
    let data;
    try {
      data = await gh(url);
    } catch (e) {
      console.error('QUERY FAIL', q, e.message);
      continue;
    }
    for (const r of data.items || []) {
      if (seen.has(r.full_name)) continue;
      seen.set(r.full_name, {
        full_name: r.full_name,
        stars: r.stargazers_count,
        lang: r.language,
        license: r.license ? r.license.spdx_id : 'NONE',
        pushed: (r.pushed_at || '').slice(0, 10),
        desc: (r.description || '').slice(0, 120),
        url: r.html_url,
        query: q,
      });
    }
    await sleep(2500);
  }
  const rows = [...seen.values()].sort((a, b) => b.stars - a.stars);
  console.log('| 仓库 | Star | License | 语言 | 最后提交 | 简介 |');
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(
      `| [${r.full_name}](${r.url}) | ${r.stars} | ${r.license} | ${r.lang || '-'} | ${r.pushed} | ${r.desc.replace(/\|/g, '/')} |`
    );
  }
  console.log('\nTOTAL', rows.length);
  require('fs').writeFileSync(
    __dirname + '/../assets/github-research.json',
    JSON.stringify(rows, null, 2),
    'utf8'
  );
})();
