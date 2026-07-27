/**
 * Lifetime Tracking — UI.
 *
 * Rendering is split in two so that logging a day stays instant even on the
 * days view, which holds ~33,000 cells:
 *
 *   buildChart()  rebuilds the DOM. Only runs when the view, date of birth or
 *                 lifespan changes.
 *   paintChart()  walks the cached cell list and rewrites className only where
 *                 it actually differs. Runs on every log.
 */
(function (global) {
  'use strict';

  var LT = global.LT;

  var VIEWS = {
    days: {
      unit: 'Days',
      axis: 'Day of the year →',
      rollup: 'Each square is one day. Click or tap any day you have lived to log it.'
    },
    weeks: {
      unit: 'Weeks',
      axis: 'Week of the year →',
      rollup: 'Each square is one week — filled when it held more good days than rough ones.'
    },
    months: {
      unit: 'Months',
      axis: 'Month of the year →',
      rollup: 'Each square is one month — it takes the verdict of most of its weeks.'
    },
    years: {
      unit: 'Years',
      axis: 'Ten years per row →',
      rollup: 'Each square is one year — it takes the verdict of most of its months.'
    }
  };

  var YEARS_PER_ROW = 10;

  var el = {};
  var state = LT.load();
  var view = 'weeks';
  var agg = null;
  var cells = [];
  var builtKey = null;
  var tooltip = null;

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  function init() {
    [
      'titleUnit', 'subtitle', 'todayLabel', 'todayDate', 'logDate',
      'btnGood', 'btnBad', 'btnClear',
      'statLogged', 'statGood', 'statBad', 'statPercent', 'statStreak', 'statBest',
      'rollup', 'axisX', 'chart', 'chartArea', 'emptyNote', 'status', 'settings',
      'dob', 'lifespan', 'palette', 'theme',
      'btnExport', 'btnImport', 'btnPrint', 'btnReset', 'importFile',
      'syncBadge', 'syncSummary', 'syncConnect', 'syncActive',
      'ghToken', 'btnConnect', 'btnSyncNow', 'btnDisconnect', 'gistLink',
      'phaseLegend', 'phaseRows', 'phaseEmpty', 'btnAddPhase', 'btnResetPhases'
    ].forEach(function (id) { el[id] = document.getElementById(id); });

    el.views = document.querySelectorAll('.view');

    el.dob.value = state.dob || '';
    el.lifespan.value = state.lifespan;
    el.palette.checked = state.palette === 'cbSafe';
    el.theme.value = state.theme;

    var todayKey = LT.toKey(LT.today());
    el.logDate.value = todayKey;
    el.logDate.max = todayKey;
    el.dob.max = todayKey;

    bindEvents();

    var fromHash = location.hash.replace('#', '');
    if (VIEWS[fromHash]) view = fromHash;

    if (!state.dob) el.settings.open = true;

    render();
    initPhaseEditor();
    initSync();
    registerServiceWorker();
  }

  function bindEvents() {
    el.btnGood.addEventListener('click', function () { setMark(LT.GOOD); });
    el.btnBad.addEventListener('click', function () { setMark(LT.BAD); });
    el.btnClear.addEventListener('click', function () { setMark(null); });

    el.logDate.addEventListener('change', function () {
      if (!el.logDate.value) el.logDate.value = LT.toKey(LT.today());
      renderToday();
    });

    Array.prototype.forEach.call(el.views, function (button) {
      button.addEventListener('click', function () {
        view = button.dataset.view;
        // replaceState, not a hash assignment — switching views should not pile
        // up history entries you have to back out of one by one.
        history.replaceState(null, '', '#' + view);
        render();
      });
    });

    el.dob.addEventListener('change', function () {
      if (!el.dob.value) return;
      LT.setSetting(state, 'dob', el.dob.value);
      commit();
    });

    el.lifespan.addEventListener('change', function () {
      var years = parseInt(el.lifespan.value, 10);
      if (!years || years < 1 || years > 130) {
        el.lifespan.value = state.lifespan;
        return;
      }
      LT.setSetting(state, 'lifespan', years);
      commit();
    });

    el.palette.addEventListener('change', function () {
      LT.setSetting(state, 'palette', el.palette.checked ? 'cbSafe' : 'classic');
      commit();
    });

    el.theme.addEventListener('change', function () {
      LT.setSetting(state, 'theme', el.theme.value);
      commit();
    });

    el.btnExport.addEventListener('click', exportJson);
    el.btnImport.addEventListener('click', function () { el.importFile.click(); });
    el.importFile.addEventListener('change', importJson);
    el.btnPrint.addEventListener('click', function () { global.print(); });
    el.btnReset.addEventListener('click', resetAll);

    el.chart.addEventListener('click', handleChartClick);
    el.chart.addEventListener('pointermove', handleChartHover);
    el.chart.addEventListener('pointerleave', hideTooltip);

    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;

      var key = e.key.toLowerCase();
      if (key === 'g') setMark(LT.GOOD);
      else if (key === 'r') setMark(LT.BAD);
      else if (key === 'x') setMark(null);
    });
  }

  /* ------------------------------------------------------------------ *
   * Mutations
   * ------------------------------------------------------------------ */

  function commit() {
    if (!LT.save(state)) {
      say('Could not save — local storage is unavailable in this browser.');
    }
    global.LTSync.schedule(getState);
    render();
  }

  function getState() {
    return state;
  }

  function setMark(mark) {
    var key = el.logDate.value || LT.toKey(LT.today());

    if (LT.dayDiff(LT.fromKey(key), LT.today()) < 0) {
      say('You can only log days that have already happened.');
      return;
    }

    LT.setEntry(state, key, mark);
    LT.save(state);
    global.LTSync.schedule(getState);

    // Cheaper than a full render: only the tallies and the cells changed.
    agg = LT.aggregate(state);
    renderToday();
    renderStats();
    renderPhaseLegend();
    paintChart();

    say(mark
      ? prettyDate(key) + ' marked as ' + (mark === LT.GOOD ? 'a good day.' : 'a rough day.')
      : prettyDate(key) + ' cleared.');
  }

  function handleChartClick(e) {
    if (view !== 'days') return;

    var cell = e.target.closest('i[data-i]');
    if (!cell) return;

    var record = cells[+cell.dataset.i];
    if (!record || !record.dateKey || record.future) return;

    var order = [null, LT.GOOD, LT.BAD];
    var next = order[(order.indexOf(state.entries[record.dateKey] || null) + 1) % order.length];

    el.logDate.value = record.dateKey;
    setMark(next);
  }

  /* ------------------------------------------------------------------ *
   * Render
   * ------------------------------------------------------------------ */

  function render() {
    agg = LT.aggregate(state);

    document.body.dataset.palette = state.palette;
    // On the root, not the body: the paper colour is painted on <html> so the
    // page has no seam below the content when the document is short.
    document.documentElement.dataset.theme = state.theme;
    el.chartArea.className = 'chart-area chart-area--' + view;
    el.titleUnit.textContent = VIEWS[view].unit;
    el.axisX.textContent = VIEWS[view].axis;
    el.rollup.textContent = VIEWS[view].rollup;

    Array.prototype.forEach.call(el.views, function (button) {
      if (button.dataset.view === view) button.setAttribute('aria-pressed', 'true');
      else button.removeAttribute('aria-pressed');
    });

    renderToday();
    renderStats();
    renderSubtitle();
    renderPhaseLegend();
    buildChart();
    paintChart();
  }

  function renderToday() {
    var key = el.logDate.value || LT.toKey(LT.today());
    var isToday = key === LT.toKey(LT.today());
    var mark = state.entries[key] || null;

    el.todayLabel.textContent = isToday ? 'today' : prettyDate(key);
    el.todayDate.textContent = prettyDate(key);
    el.todayDate.dateTime = key;

    el.btnGood.setAttribute('aria-pressed', String(mark === LT.GOOD));
    el.btnBad.setAttribute('aria-pressed', String(mark === LT.BAD));
    el.btnClear.disabled = !mark;
  }

  function renderStats() {
    var s = LT.stats(state);

    el.statLogged.textContent = s.logged;
    el.statGood.textContent = s.good;
    el.statBad.textContent = s.bad;
    el.statPercent.textContent = s.logged ? s.goodPercent + '%' : '—';
    el.statBest.textContent = s.longestGood ? s.longestGood + 'd' : '—';

    if (s.current.length) {
      el.statStreak.textContent = s.current.length + 'd';
      el.statStreak.className = 'stat-value stat-value--' + (s.current.mark === LT.GOOD ? 'good' : 'bad');
    } else {
      el.statStreak.textContent = '—';
      el.statStreak.className = 'stat-value';
    }
  }

  function renderSubtitle() {
    if (!state.dob) {
      el.subtitle.textContent = 'Set your date of birth in Settings to begin.';
      return;
    }

    var dob = LT.fromKey(state.dob);
    var pos = LT.lifePosition(dob, LT.today());

    if (!pos) {
      el.subtitle.textContent = 'That date of birth is in the future.';
      return;
    }

    var lived = LT.dayDiff(dob, LT.today());
    var total = totalDays();
    var percent = total ? ((lived / total) * 100).toFixed(1) : '0';

    el.subtitle.textContent = 'Age ' + pos.age + ' · ' + lived.toLocaleString() +
      ' days lived · ' + percent + '% of ' + state.lifespan + ' years.';
  }

  function totalDays() {
    if (!state.dob) return 0;
    var dob = LT.fromKey(state.dob);
    return LT.dayDiff(dob, LT.anniversary(dob, state.lifespan));
  }

  /* ------------------------------------------------------------------ *
   * Chart construction
   * ------------------------------------------------------------------ */

  /**
   * Describes each row of the current view: how many cells it holds and what
   * the left-hand age label should read.
   */
  function rowPlan() {
    var dob = state.dob ? LT.fromKey(state.dob) : null;
    var rows = [];
    var age;

    if (view === 'years') {
      for (var start = 0; start < state.lifespan; start += YEARS_PER_ROW) {
        rows.push({
          label: String(start),
          startAge: start,
          count: Math.min(YEARS_PER_ROW, state.lifespan - start)
        });
      }
      return rows;
    }

    for (age = 0; age < state.lifespan; age++) {
      var count;
      if (view === 'days') count = dob ? LT.daysInLifeYear(dob, age) : 365;
      else if (view === 'weeks') count = LT.WEEKS_PER_YEAR;
      else count = LT.MONTHS_PER_YEAR;

      rows.push({
        // Label every fifth year so the axis stays readable at small sizes.
        label: age % 5 === 0 ? String(age) : '',
        startAge: age,
        count: count
      });
    }
    return rows;
  }

  function buildChart() {
    var key = [view, state.dob, state.lifespan, JSON.stringify(state.phases)].join('|');
    if (key === builtKey) return;
    builtKey = key;

    if (!state.dob) {
      el.chart.innerHTML = '';
      el.chart.hidden = true;
      el.emptyNote.hidden = false;
      cells = [];
      return;
    }

    el.chart.hidden = false;
    el.emptyNote.hidden = true;

    var dob = LT.fromKey(state.dob);
    var plan = rowPlan();
    var columns = view === 'years' ? YEARS_PER_ROW
      : view === 'weeks' ? LT.WEEKS_PER_YEAR
      : view === 'months' ? LT.MONTHS_PER_YEAR
      : maxOf(plan);

    var html = [];
    var index = 0;
    cells = [];

    plan.forEach(function (row, rowIndex) {
      html.push('<div class=row><span class=lbl>' + row.label + '</span>' +
        railFor(row, plan[rowIndex - 1], plan[rowIndex + 1]) +
        '<div class=cells style="' + tintFor(row) + '">');

      for (var i = 0; i < row.count; i++) {
        var record = { age: row.startAge, idx: i, dateKey: null, future: false, el: null };

        if (view === 'years') {
          record.age = row.startAge + i;
          record.idx = 0;
        } else if (view === 'days') {
          record.dateKey = LT.toKey(LT.addDays(LT.anniversary(dob, row.startAge), i));
        }

        cells.push(record);
        if (view === 'years') {
          html.push(slotFor(record.age) + '<i data-i=' + index + '></i></span>');
        } else {
          html.push('<i data-i=' + index + '></i>');
        }
        index++;
      }

      html.push('</div></div>');
    });

    el.chart.style.setProperty('--cols', columns);
    el.chart.className = 'chart chart--' + view;
    el.chart.innerHTML = html.join('');

    // One pass to attach element references; cheaper than querying per repaint.
    var nodes = el.chart.getElementsByTagName('i');
    for (var n = 0; n < nodes.length; n++) cells[n].el = nodes[n];

    scrollToToday();
  }

  /**
   * The days grid is ~1500px wide, so on any screen it opens showing infancy.
   * Nudge it across to the part of the year you are actually living in.
   */
  function scrollToToday() {
    if (view !== 'days') return;

    var scroller = el.chart.parentNode;
    var now = LT.lifePosition(LT.fromKey(state.dob), LT.today());
    if (!now) return;

    var fraction = now.dayOfYear / 366;
    var target = fraction * el.chart.scrollWidth - scroller.clientWidth / 2;
    scroller.scrollLeft = Math.max(0, target);
  }

  function maxOf(plan) {
    return plan.reduce(function (max, row) { return Math.max(max, row.count); }, 0);
  }

  /* ------------------------------------------------------------------ *
   * Phases
   * ------------------------------------------------------------------ */

  // The gutter rail is the primary phase cue and the row tint only carries it
  // across the width of the chart, so it stays faint — much stronger and the
  // empty future decades read as solid colour bands that drown the data.
  //
  // The years view has no rail (a row there is a decade, not an age), so it
  // gets a stronger block behind each cell instead and needs no row tint.
  var TINT_ALPHA = 0.09;
  var BLOCK_ALPHA = 0.8;

  function rgba(hex, alpha) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  /** Every age this row covers. One age for most views; a decade for years. */
  function agesOf(row) {
    var ages = [];
    var count = view === 'years' ? row.count : 1;
    for (var i = 0; i < count; i++) ages.push(row.startAge + i);
    return ages;
  }

  /**
   * Background tint behind a row's cells.
   *
   * In days/weeks/months a row is a single year of life, so it is one flat
   * colour. The years view packs ten years into a row, so a phase boundary can
   * fall mid-row — a hard-stop gradient puts the change exactly at the right
   * column without needing a wrapper element around all 33,000 day cells.
   */
  function tintFor(row) {
    if (view === 'years') return '';

    var phase = LT.phaseAt(state.phases || [], row.startAge);
    return phase ? 'background:' + rgba(phase.color, TINT_ALPHA) : '';
  }

  /**
   * The years view packs a decade into each row, so a phase boundary can fall
   * mid-row and a vertical rail cannot express it. Each year cell instead sits
   * on a phase-coloured pad; neighbouring years in the same phase butt together
   * into a continuous block, which reads like highlighted text.
   */
  function slotFor(age) {
    var phase = LT.phaseAt(state.phases || [], age);
    if (!phase) return '<span class=slot>';

    // A strip under the cell rather than a pad behind it. A wash behind an
    // unlived year turns its outline into a filled tile and the year stops
    // reading as a cell at all; sitting underneath, consecutive years still
    // join into one unbroken line without touching the grid itself.
    return '<span class=slot style="--phase:' + rgba(phase.color, BLOCK_ALPHA) +
           '" title="' + escapeHtml(phase.label || 'Phase') + ' · ages ' +
           phase.from + '–' + phase.to + '">';
  }

  /**
   * The solid bar in the gutter. Only meaningful where a row is one age —
   * in the years view a row spans a decade, so the gradient above carries the
   * phase instead and the rail is left blank.
   */
  function railFor(row, previous, next) {
    if (view === 'years') return '<span class="rail rail--muted"></span>';

    var phase = LT.phaseAt(state.phases || [], row.startAge);
    if (!phase) return '<span class=rail></span>';

    var startsHere = !previous || LT.phaseAt(state.phases, previous.startAge) !== phase;
    var endsHere = !next || LT.phaseAt(state.phases, next.startAge) !== phase;
    var edge = (startsHere ? ' rail--first' : '') + (endsHere ? ' rail--last' : '');

    return '<span class="rail' + edge + '" style="background:' + rgba(phase.color, 0.72) +
           '" title="' + escapeHtml(phase.label || 'Phase') + ' · ages ' +
           phase.from + '–' + phase.to + '"></span>';
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
    });
  }

  function renderPhaseLegend() {
    var buckets = LT.phaseStats(state);

    if (!buckets.length) {
      el.phaseLegend.innerHTML = '';
      el.phaseLegend.hidden = true;
      return;
    }

    el.phaseLegend.hidden = false;
    el.phaseLegend.innerHTML = buckets.map(function (bucket) {
      var phase = bucket.phase;
      var detail = bucket.logged
        ? bucket.logged + ' logged · ' + bucket.goodPercent + '% good'
        : 'nothing logged';

      return '<span class="phase-item"' +
        ' title="' + escapeHtml(phase.label || 'Phase') + ': ' + detail + '">' +
        '<i class="phase-swatch" style="background:' + rgba(phase.color, 0.72) + '"></i>' +
        '<span class="phase-name">' + escapeHtml(phase.label || '—') + '</span>' +
        '<span class="phase-range">' + phase.from + '–' + phase.to + '</span>' +
        '<span class="phase-stat">' + detail + '</span>' +
        '</span>';
    }).join('');
  }

  /**
   * Assign every cell its class. Cheap enough to run on every keystroke because
   * we only touch the DOM when the computed class actually changed.
   */
  function paintChart() {
    if (!cells.length || !state.dob) return;

    var dob = LT.fromKey(state.dob);
    var now = LT.lifePosition(dob, LT.today());
    var todayKey = LT.toKey(LT.today());

    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      var mark = null;
      var future;
      var isNow;

      if (view === 'days') {
        mark = state.entries[cell.dateKey] || null;
        future = !now || cell.dateKey > todayKey;
        isNow = cell.dateKey === todayKey;
      } else if (view === 'weeks') {
        mark = agg.weeks[cell.age][cell.idx].mark;
        future = !now || cell.age > now.age || (cell.age === now.age && cell.idx > now.week);
        isNow = !!now && cell.age === now.age && cell.idx === now.week;
      } else if (view === 'months') {
        mark = agg.months[cell.age][cell.idx].mark;
        future = !now || cell.age > now.age || (cell.age === now.age && cell.idx > now.month);
        isNow = !!now && cell.age === now.age && cell.idx === now.month;
      } else {
        mark = agg.years[cell.age].mark;
        future = !now || cell.age > now.age;
        isNow = !!now && cell.age === now.age;
      }

      cell.future = future;

      var className = mark === LT.GOOD ? 'g'
        : mark === LT.BAD ? 'b'
        : mark === LT.TIE ? 't'
        : future ? '' : 'p';

      if (isNow) className = className ? className + ' now' : 'now';

      if (cell.el.className !== className) cell.el.className = className;
    }
  }

  /* ------------------------------------------------------------------ *
   * Tooltip
   * ------------------------------------------------------------------ */

  function handleChartHover(e) {
    var node = e.target.closest ? e.target.closest('i[data-i]') : null;
    if (!node) { hideTooltip(); return; }

    var text = describeCell(cells[+node.dataset.i]);
    if (!text) { hideTooltip(); return; }

    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.className = 'tooltip';
      document.body.appendChild(tooltip);
    }

    tooltip.textContent = text;
    tooltip.hidden = false;

    var width = tooltip.offsetWidth;
    var left = Math.min(Math.max(8, e.clientX - width / 2), global.innerWidth - width - 8);
    tooltip.style.left = left + 'px';
    tooltip.style.top = (e.clientY + global.scrollY - tooltip.offsetHeight - 12) + 'px';
  }

  function hideTooltip() {
    if (tooltip) tooltip.hidden = true;
  }

  function describeCell(cell) {
    if (!cell || !state.dob) return '';

    var dob = LT.fromKey(state.dob);
    var phase = LT.phaseAt(state.phases || [], cell.age);
    var chapter = phase && phase.label ? ' · ' + phase.label : '';

    if (view === 'days') {
      var mark = state.entries[cell.dateKey];
      return prettyDate(cell.dateKey) + ' · age ' + cell.age + chapter + ' · ' +
        (mark === LT.GOOD ? 'good' : mark === LT.BAD ? 'rough' : cell.future ? 'ahead of you' : 'not logged');
    }

    if (view === 'years') {
      var year = agg.years[cell.age];
      return 'Age ' + cell.age + ' · ' + LT.anniversary(dob, cell.age).getFullYear() + chapter +
        ' · ' + tallyText(year, 'month');
    }

    if (view === 'weeks') {
      var week = agg.weeks[cell.age][cell.idx];
      var start = LT.addDays(LT.anniversary(dob, cell.age), cell.idx * 7);
      var end = cell.idx === LT.WEEKS_PER_YEAR - 1
        ? LT.addDays(LT.anniversary(dob, cell.age + 1), -1)
        : LT.addDays(start, 6);
      return 'Age ' + cell.age + ', week ' + (cell.idx + 1) + chapter + ' · ' +
        prettyDate(LT.toKey(start)) + ' – ' + prettyDate(LT.toKey(end)) + ' · ' +
        tallyText(week, 'day');
    }

    var month = agg.months[cell.age][cell.idx];
    var range = weekRangeForMonth(cell.idx);
    return 'Age ' + cell.age + ', month ' + (cell.idx + 1) + chapter +
      ' · weeks ' + (range.first + 1) + '–' + (range.last + 1) + ' · ' +
      tallyText(month, 'week');
  }

  function weekRangeForMonth(month) {
    var first = -1;
    var last = -1;
    for (var w = 0; w < LT.WEEKS_PER_YEAR; w++) {
      if (LT.monthOfWeek(w) === month) {
        if (first === -1) first = w;
        last = w;
      }
    }
    return { first: first, last: last };
  }

  function tallyText(bucket, noun) {
    if (!bucket.good && !bucket.bad) return 'nothing logged';
    var parts = [];
    if (bucket.good) parts.push(bucket.good + ' good ' + plural(noun, bucket.good));
    if (bucket.bad) parts.push(bucket.bad + ' rough ' + plural(noun, bucket.bad));
    var label = bucket.mark === LT.TIE ? 'even split' : bucket.mark === LT.GOOD ? 'good' : 'rough';
    return parts.join(', ') + ' → ' + label;
  }

  function plural(noun, count) {
    return count === 1 ? noun : noun + 's';
  }

  /* ------------------------------------------------------------------ *
   * Data in / out
   * ------------------------------------------------------------------ */

  function exportJson() {
    var payload = JSON.stringify(state, null, 2);
    var blob = new Blob([payload], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');

    link.href = url;
    link.download = 'lifetime-tracking-' + LT.toKey(LT.today()) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    say('Exported ' + Object.keys(state.entries).length + ' entries.');
  }

  /**
   * Imports merge rather than replace: entries from the file win on conflict,
   * everything already here survives. That makes moving a log between a laptop
   * and a phone safe in both directions.
   */
  function importJson(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;

    var reader = new FileReader();

    reader.onload = function () {
      var incoming;
      try {
        incoming = LT.sanitize(JSON.parse(reader.result));
      } catch (err) {
        say('That file is not valid JSON.');
        return;
      }

      var before = Object.keys(state.entries).length;

      // Same merge the sync path uses, so importing a file and syncing a device
      // resolve conflicts identically.
      state = LT.mergeStates(state, incoming);

      var added = Object.keys(state.entries).length - before;

      el.dob.value = state.dob || '';
      el.lifespan.value = state.lifespan;
      el.palette.checked = state.palette === 'cbSafe';

      builtKey = null;
      commit();
      say('Merged ' + Object.keys(incoming.entries).length + ' entries — ' +
          added + ' new to this device.');
    };

    reader.readAsText(file);
    e.target.value = '';
  }

  function resetAll() {
    if (!global.confirm('Erase your date of birth and every logged day? This cannot be undone.')) return;

    // Clear each day through setEntry so every removal leaves a tombstone. A
    // bare reset would look like "this device knows nothing" and the next sync
    // would cheerfully restore everything from the gist.
    Object.keys(state.entries).forEach(function (key) { LT.setEntry(state, key, null); });
    LT.setSetting(state, 'dob', null);
    LT.setSetting(state, 'lifespan', 90);
    LT.setSetting(state, 'palette', 'classic');
    LT.setSetting(state, 'theme', 'paper');

    LT.save(state);
    global.LTSync.schedule(getState, 0);

    el.dob.value = '';
    el.lifespan.value = state.lifespan;
    el.palette.checked = false;
    el.theme.value = 'paper';
    builtKey = null;

    render();
    say('Everything erased.');
  }

  /* ------------------------------------------------------------------ *
   * Phase editor
   * ------------------------------------------------------------------ */

  function renderPhaseEditor() {
    var phases = state.phases || [];

    el.phaseRows.innerHTML = phases.map(function (phase, i) {
      return '<div class="phase-edit" data-i="' + i + '">' +
        '<input type="color" class="pe-color" value="' + phase.color +
          '" aria-label="Colour for ' + escapeHtml(phase.label) + '">' +
        '<input type="text" class="pe-label" maxlength="40" value="' +
          escapeHtml(phase.label) + '" placeholder="Name" aria-label="Phase name">' +
        '<input type="number" class="pe-from" min="0" max="130" value="' + phase.from +
          '" aria-label="Start age">' +
        '<span class="pe-dash">–</span>' +
        '<input type="number" class="pe-to" min="1" max="130" value="' + phase.to +
          '" aria-label="End age">' +
        '<button type="button" class="pe-remove" aria-label="Remove ' +
          escapeHtml(phase.label) + '">&times;</button>' +
        '</div>';
    }).join('');

    el.phaseEmpty.hidden = phases.length > 0;
  }

  /** Rebuild the phase list from whatever is currently in the inputs. */
  function readPhaseEditor() {
    return Array.prototype.map.call(
      el.phaseRows.querySelectorAll('.phase-edit'),
      function (row) {
        return {
          label: row.querySelector('.pe-label').value.trim(),
          from: parseInt(row.querySelector('.pe-from').value, 10),
          to: parseInt(row.querySelector('.pe-to').value, 10),
          color: row.querySelector('.pe-color').value
        };
      }
    );
  }

  function commitPhases(phases) {
    LT.setSetting(state, 'phases', phases);
    builtKey = null;              // the tint is baked into the row markup
    commit();
    renderPhaseEditor();
  }

  function initPhaseEditor() {
    // Ranges are re-sorted on save, so commit on `change` (which fires at blur)
    // rather than `input` — otherwise rows would reshuffle mid-keystroke.
    el.phaseRows.addEventListener('change', function () {
      commitPhases(readPhaseEditor());
    });

    el.phaseRows.addEventListener('click', function (e) {
      var button = e.target.closest('.pe-remove');
      if (!button) return;

      var index = +button.parentNode.dataset.i;
      var phases = readPhaseEditor();
      phases.splice(index, 1);
      commitPhases(phases);
      say('Phase removed.');
    });

    el.btnAddPhase.addEventListener('click', function () {
      var phases = readPhaseEditor();
      var last = phases[phases.length - 1];
      var from = last ? Math.min(last.to, 125) : 0;

      phases.push({
        label: 'New phase',
        from: from,
        to: Math.min(from + 5, 130),
        color: PHASE_COLORS[phases.length % PHASE_COLORS.length]
      });

      commitPhases(phases);
      var added = el.phaseRows.querySelector('.phase-edit:last-child .pe-label');
      if (added) { added.focus(); added.select(); }
    });

    el.btnResetPhases.addEventListener('click', function () {
      commitPhases(LT.DEFAULT_PHASES);
      say('Phases reset to the defaults.');
    });

    renderPhaseEditor();
  }

  var PHASE_COLORS = ['#96c0ce', '#5f97a4', '#2b6470', '#d8ba98',
                      '#bf9264', '#a8604a', '#8d4038', '#8a8279'];

  /* ------------------------------------------------------------------ *
   * Sync
   * ------------------------------------------------------------------ */

  var Sync = global.LTSync;

  function initSync() {
    Sync.onChange(renderSync);

    el.btnConnect.addEventListener('click', function () {
      var token = el.ghToken.value.trim();
      if (!token) { say('Paste a GitHub token first.'); return; }

      el.btnConnect.disabled = true;

      Sync.connect(token, state)
        .then(function (result) {
          el.ghToken.value = '';
          adopt(result.state);
          say(result.created
            ? 'Connected — created a new private gist for your log.'
            : 'Connected — merged with the log already in your gist.');
        })
        .catch(function (err) {
          say('Could not connect: ' + err.message);
        })
        .then(function () {
          el.btnConnect.disabled = false;
          renderSync();
        });
    });

    el.btnSyncNow.addEventListener('click', function () {
      Sync.flush(getState).then(adopt);
    });

    el.btnDisconnect.addEventListener('click', function () {
      if (!global.confirm('Stop syncing this device? Your log stays on the device and in the gist.')) return;
      Sync.disconnect();
      say('Disconnected. This device no longer syncs.');
      renderSync();
    });

    // Coming back to the app is the moment the other device's edits matter most.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) Sync.sync(state).then(adopt);
    });

    global.addEventListener('online', function () { Sync.sync(state).then(adopt); });

    // A pending debounce would otherwise be lost when the tab closes.
    global.addEventListener('pagehide', function () {
      if (Sync.isConnected() && Sync.isDirty(state)) Sync.flush(getState);
    });

    renderSync();
    if (Sync.isConnected()) Sync.sync(state).then(adopt);
  }

  /**
   * Take on a state that came back from a merge. Object identity changes, so the
   * chart has to be rebuilt from scratch rather than repainted.
   */
  function adopt(merged) {
    if (!merged || merged === state) { renderSync(); return; }

    state = merged;
    el.dob.value = state.dob || '';
    el.lifespan.value = state.lifespan;
    el.palette.checked = state.palette === 'cbSafe';
    el.theme.value = state.theme;
    builtKey = null;
    render();
    renderPhaseEditor();
    renderSync();
  }

  var SYNC_LABELS = {
    off: 'Off',
    ok: 'Synced',
    syncing: 'Syncing…',
    pending: 'Pending',
    offline: 'Offline',
    error: 'Error'
  };

  function renderSync() {
    var status = Sync.status;
    var connected = Sync.isConnected();
    var config = Sync.config();

    el.syncBadge.textContent = SYNC_LABELS[status.state] || status.state;
    el.syncBadge.dataset.state = status.state;

    el.syncConnect.hidden = connected;
    el.syncActive.hidden = !connected;
    el.btnSyncNow.disabled = status.busy;

    if (connected) {
      el.gistLink.href = 'https://gist.github.com/' + config.gistId;
    }

    if (status.message) {
      el.syncSummary.textContent = status.message;
    } else if (connected && config.lastSyncAt) {
      el.syncSummary.textContent = 'Last synced ' + relativeTime(config.lastSyncAt) + '.';
    } else if (!connected) {
      el.syncSummary.textContent = 'Connect a GitHub token to keep this device and your ' +
        'phone on the same log. Edits merge; nothing is overwritten.';
    }
  }

  function relativeTime(at) {
    var seconds = Math.round((Date.now() - at) / 1000);
    if (seconds < 60) return 'just now';
    if (seconds < 3600) return Math.round(seconds / 60) + ' min ago';
    if (seconds < 86400) return Math.round(seconds / 3600) + ' h ago';
    return prettyDate(LT.toKey(new Date(at)));
  }

  /* ------------------------------------------------------------------ *
   * Misc
   * ------------------------------------------------------------------ */

  function prettyDate(key) {
    return LT.fromKey(key).toLocaleDateString(undefined, {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric'
    });
  }

  function say(message) {
    el.status.textContent = message;
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline support is optional */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
