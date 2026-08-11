// tables.js — Connexli's reusable table enhancer (Paul, Aug 11).
// Any <table class="dt"> automatically gains: click-to-sort headers,
// live search, page-size choice (10/20/50), and pagination. Server-rendered
// HTML stays the source of truth; this only reorders/hides rows, so every
// dashboard behaves the same and future upgrades land everywhere at once.
(function () {
  function enhance(table) {
    var headRow = table.querySelector('tr');
    if (!headRow) return;
    var ths = Array.from(headRow.querySelectorAll('th'));
    if (!ths.length) return;
    var rows = Array.from(table.querySelectorAll('tr')).slice(1);
    if (rows.length < 2 && !table.dataset.dtAlways) return; // nothing to sort/page

    var state = { sortCol: -1, sortDir: 1, filter: '', page: 0, size: 10 };

    // Controls bar
    var bar = document.createElement('div');
    bar.className = 'dt-controls';
    bar.innerHTML = '<input type="search" placeholder="Search…" aria-label="Search table">' +
      '<select aria-label="Rows per page"><option value="10">Show 10</option><option value="20">Show 20</option><option value="50">Show 50</option></select>' +
      '<span class="dt-info"></span><button type="button" class="dt-prev" aria-label="Previous page">‹</button><button type="button" class="dt-next" aria-label="Next page">›</button>';
    table.parentNode.insertBefore(bar, table);
    var search = bar.querySelector('input'), sizeSel = bar.querySelector('select'),
        info = bar.querySelector('.dt-info'), prev = bar.querySelector('.dt-prev'), next = bar.querySelector('.dt-next');

    function cellVal(row, i) {
      var c = row.cells[i];
      if (!c) return '';
      return c.dataset.sort !== undefined ? c.dataset.sort : c.textContent.trim();
    }
    function cmp(a, b) {
      var x = cellVal(a, state.sortCol), y = cellVal(b, state.sortCol);
      var nx = parseFloat(x.replace(/[^0-9.-]/g, '')), ny = parseFloat(y.replace(/[^0-9.-]/g, ''));
      var bothNum = !isNaN(nx) && !isNaN(ny) && /\d/.test(x) && /\d/.test(y);
      var r = bothNum ? nx - ny : x.localeCompare(y, undefined, { sensitivity: 'base' });
      return r * state.sortDir;
    }
    function render() {
      var visible = rows.filter(function (r) {
        return !state.filter || r.textContent.toLowerCase().includes(state.filter);
      });
      if (state.sortCol >= 0) visible = visible.slice().sort(cmp);
      var pages = Math.max(1, Math.ceil(visible.length / state.size));
      if (state.page >= pages) state.page = pages - 1;
      var start = state.page * state.size;
      var pageRows = visible.slice(start, start + state.size);
      rows.forEach(function (r) { r.style.display = 'none'; });
      // Reinsert in order after the header row
      var anchor = headRow;
      pageRows.forEach(function (r) {
        r.style.display = '';
        anchor.parentNode.insertBefore(r, anchor.nextSibling);
        anchor = r;
      });
      info.textContent = visible.length ? (start + 1) + '–' + Math.min(start + state.size, visible.length) + ' of ' + visible.length : '0 results';
      prev.disabled = state.page === 0;
      next.disabled = state.page >= pages - 1;
      ths.forEach(function (th, i) {
        th.classList.toggle('dt-asc', i === state.sortCol && state.sortDir === 1);
        th.classList.toggle('dt-desc', i === state.sortCol && state.sortDir === -1);
      });
    }
    ths.forEach(function (th, i) {
      th.classList.add('dt-sortable');
      th.setAttribute('role', 'button');
      th.addEventListener('click', function () {
        if (state.sortCol === i) state.sortDir *= -1; else { state.sortCol = i; state.sortDir = 1; }
        render();
      });
    });
    search.addEventListener('input', function () { state.filter = search.value.toLowerCase(); state.page = 0; render(); });
    sizeSel.addEventListener('change', function () { state.size = parseInt(sizeSel.value); state.page = 0; render(); });
    prev.addEventListener('click', function () { state.page--; render(); });
    next.addEventListener('click', function () { state.page++; render(); });
    render();
  }
  document.querySelectorAll('table.dt').forEach(enhance);
})();
