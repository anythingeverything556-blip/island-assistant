// "A new version is out": once a day Island asks GitHub which release is newest and, if it's
// newer than this one, says so with a link to download it. Nothing is installed by itself.
// The repository comes from package.json ("updates": "owner/repo"); without it nothing is checked.
const https = require('https');

const DAY = 24 * 60 * 60 * 1000;

// "1.10.2" > "1.9.9"
function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function latestRelease(repo, url = `https://api.github.com/repos/${repo}/releases/latest`) {
  return new Promise((resolve) => {
    const req = https.get(url, { headers: { 'user-agent': 'Island-update-check', accept: 'application/vnd.github+json' }, timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          resolve(res.statusCode === 200 && j.tag_name ? { version: j.tag_name.replace(/^v/, ''), url: j.html_url, notes: String(j.body || '').slice(0, 600) } : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// onUpdate({ version, url, notes }) is called at most once per new version.
function startUpdateChecks({ repo, current, getSeen, setSeen, onUpdate }) {
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return () => {};
  const check = async () => {
    const r = await latestRelease(repo);
    if (r && newer(r.version, current) && getSeen() !== r.version) {
      setSeen(r.version);
      onUpdate(r);
    }
  };
  const first = setTimeout(check, 60 * 1000); // not during start-up
  const timer = setInterval(check, DAY);
  return () => { clearTimeout(first); clearInterval(timer); };
}

module.exports = { startUpdateChecks, newer, latestRelease };
