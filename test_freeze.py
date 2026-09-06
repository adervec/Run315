"""Self-check for the static-site freezer. Run: python test_freeze.py"""
import os

os.environ.setdefault("FREEZE_DB", "test-freeze.db")
import freeze as F                                          # noqa: E402


def test_url_becomes_the_file_a_directory_host_will_serve():
    assert F.out_path("/") == F.OUT / "index.html"
    assert F.out_path("/vitals") == F.OUT / "vitals" / "index.html"
    assert F.out_path("/race/3") == F.OUT / "race" / "3" / "index.html"
    # A name with an extension is a file, not a directory to index.
    assert F.out_path("/export.csv") == F.OUT / "export.csv"


def test_links_are_stripped_back_to_app_relative_paths():
    old = F.BASE
    F.BASE = "/Run315"
    try:
        html = ('<a href="/Run315/vitals">v</a>'
                '<a href="/Run315/static/style.css">s</a>'
                '<a href="https://brouter.de/x">out</a>'
                '<a href="mailto:a@b.c">mail</a>'
                '<a href="#top">anchor</a>'
                '<a href="/Run315/race/1">r</a>')
        assert F.links(html) == ["/vitals", "/race/1"]
        # The site root itself must come back as "/" and not as "".
        assert F.links('<a href="/Run315">home</a>') == ["/"]
    finally:
        F.BASE = old


def test_links_work_without_a_base_path_too():
    old = F.BASE
    F.BASE = ""
    try:
        assert F.links('<a href="/gear">g</a><a href="/static/x.js">s</a>') == ["/gear"]
    finally:
        F.BASE = old


def test_the_banner_disables_posts_rather_than_hiding_them():
    """A frozen page must not offer a button that will 405 when pressed."""
    assert "preventDefault" in F.BANNER
    assert "Static demo" in F.BANNER


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
        print("ok  " + t.__name__)
    print("\n%d passed" % len(tests))
