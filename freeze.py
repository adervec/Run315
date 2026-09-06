"""Freeze the demo athlete into a static site for GitHub Pages.

GitHub Pages serves files, not Flask. So: seed the synthetic athlete, log in
as them with a test client, crawl every internal link from the dashboard, and
write what comes back to docs/. Everything that reads works. Everything that
writes -- sync, add a race, ask the coach -- is switched off with a banner
saying so, because on a static host those buttons would just 405.

    python freeze.py                 # docs/, links rooted at /
    BASE_PATH=/Run315 python freeze.py

Run: python freeze.py && python -m http.server -d docs
"""
import os
import re
import shutil
import sys
from pathlib import Path

os.environ.setdefault("SECRET_KEY", "static-demo-not-a-secret")
os.environ["DATABASE_PATH"] = os.environ.get("FREEZE_DB", "freeze-demo.db")
if "--demo" not in sys.argv:
    sys.argv.append("--demo")           # app.py reads DEMO off argv at import

import app as A                                             # noqa: E402

OUT = Path(os.environ.get("FREEZE_OUT", "docs"))
BASE = os.environ.get("BASE_PATH", "").rstrip("/")
SOURCE = os.environ.get("SOURCE_URL", "https://github.com/adervec/Run315")

# Fetched by JavaScript rather than linked, so the crawler never sees them.
SEEDS = ("/", "/api/tiles", "/api/trails", "/api/routes", "/api/poi-layers",
         "/export.csv")

BANNER = """
<div id="frozen-note">
  <b>Static demo.</b> A synthetic athlete, frozen to files &mdash; every page
  here is the real app rendering real analysis, but anything that writes
  (Garmin sync, adding a race, the coach review) is switched off, because a
  file server has nothing to write to.
  <a href="%s">Source &amp; how to run it for real</a>.
</div>
<style>
  #frozen-note { position: sticky; bottom: 0; z-index: 99;
    font: 13px/1.5 system-ui, sans-serif; background: #1b1f24; color: #d8dee6;
    padding: 10px 18px; border-top: 2px solid #f5a623; }
  #frozen-note a { color: #f5a623; }
  form.frozen button, form.frozen input[type=submit] { opacity: .45; }
</style>
<script>
  // Nothing here can POST. Stop the form rather than let it 405.
  document.querySelectorAll('form').forEach(function (f) {
    if ((f.method || '').toLowerCase() !== 'post') return;
    f.classList.add('frozen');
    f.addEventListener('submit', function (e) { e.preventDefault(); });
    f.querySelectorAll('button, input[type=submit]').forEach(function (b) {
      b.title = 'Disabled in the static demo';
    });
  });
</script>
"""


def out_path(path):
    """URL path -> file to write. /vitals -> vitals/index.html, so that a
    plain directory-index host serves it at the URL the links use."""
    rel = path.strip("/")
    if not rel:
        return OUT / "index.html"
    if "." in rel.rsplit("/", 1)[-1]:
        return OUT / rel                        # export.csv keeps its name
    return OUT / rel / "index.html"


def links(html):
    """Internal GET links worth following, as app-relative paths."""
    found = []
    for href in re.findall(r'href="([^"]*)"', html):
        href = href.strip()
        if not href or href[0] in "#?" or "://" in href or ":" in href.split("/")[0]:
            continue
        if not href.startswith("/"):
            continue                            # relative links: none in here
        if BASE and href.startswith(BASE + "/"):
            href = href[len(BASE):]
        elif BASE and href == BASE:
            href = "/"
        if href.startswith("/static/") or "?" in href or "#" in href:
            continue
        found.append(href)
    return found


def freeze():
    if OUT.exists():
        shutil.rmtree(OUT)
    OUT.mkdir(parents=True)

    A.init_db()
    uid = A.seed_demo()

    client = A.app.test_client()
    with client.session_transaction() as sess:
        sess["uid"] = uid

    env = {"SCRIPT_NAME": BASE} if BASE else {}
    seen, queue, written, skipped = set(), list(SEEDS), 0, []

    while queue:
        path = queue.pop(0)
        if path in seen:
            continue
        seen.add(path)

        res = client.get(path, environ_overrides=env)
        if res.status_code != 200:
            skipped.append((path, res.status_code))
            continue

        body = res.get_data()
        if b"</body>" in body:
            text = body.decode("utf-8")
            queue.extend(links(text))
            body = text.replace("</body>", BANNER % SOURCE + "</body>").encode("utf-8")

        dest = out_path(path)
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        written += 1

    shutil.copytree("static", OUT / "static")
    if BASE:
        # routes.js hardcodes /api/... which is the wrong root under a
        # project page. Rewrite the copy, not the source.
        js = OUT / "static" / "routes.js"
        js.write_text(js.read_text(encoding="utf-8").replace("('/api/", "('%s/api/" % BASE),
                      encoding="utf-8")
    (OUT / ".nojekyll").touch()                  # ponytail: Jekyll eats _dirs
    # A 404 that still looks like the app beats GitHub's default.
    miss = OUT / "404.html"
    miss.write_bytes((OUT / "index.html").read_bytes())

    print("\n%d pages -> %s/  (base %r)" % (written, OUT, BASE or "/"))
    for path, code in skipped:
        print("  skipped %s (%s)" % (path, code))
    assert written > 10, "the crawl found almost nothing -- did login work?"
    assert (OUT / "vitals" / "index.html").exists(), "vitals did not render"
    return written


if __name__ == "__main__":
    freeze()
