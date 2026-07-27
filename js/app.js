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
      rollup: 'Each square is one week — green when it held more good days than rough ones.'
    },
    months: {
      unit: 'Months',
      axis: 'Month of the year →',
      rollup: 'Each circle is one month — green when more of its weeks were green than red.'
    },
    years: {
      unit: 'Years',
      axis: 'Ten years per row →',
      rollup: 'Each diamond is one year — green when more of its months were green than red.'
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
      'rollup', 'axisX', 'chart', 'emptyNote', 'status', 'settings',
      'dob', 'lifespan', 'palette',
      'btnExport', 'btnImport', 'btnPrint', 'btnReset', 'importFile'
    ].forEach(function (id) { el[id] = document.getElementById(id); });

    el.views = document.querySelectorAll('.view');

    el.dob.value = state.dob || '';
    el.lifespan.value = state.lifespan;
    el.palette.checked = state.palette === 'cbSafe';

    var todayKey = LT.toKey(LT.today());
    el.logDate.value = todayKey;
    el.logDate.max = todayKey;
    el.dob.max = todayKey;

    bindEvents();

    if (!state.dob) el.settings.open = true;

    render();
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
        render();
      });
    });

    el.dob.addEventListener('change', function () {
      state.dob = el.dob.value || null;
      commit();
    });

    el.lifespan.addEventListener('change', function () {
      var years = parseInt(el.lifespan.value, 10);
      if (!years || years < 1 || years > 130) {
        el.lifespan.value = state.lifespan;
        return;
      }
      state.lifespan = years;
      commit();
    });

    el.palette.addEventListener('change', function () {
      state.palette = el.palette.checked ? 'cbSafe' : 'classic';
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
    render();
  }

  function setMark(mark) {
    var key = el.logDate.value || LT.toKey(LT.today());

    if (LT.dayDiff(LT.fromKey(key), LT.today()) < 0) {
      say('You can only log days that have already happened.');
      return;
    }

    if (mark) state.entries[key] = mark;
    else delete state.entries[key];

    LT.save(state);
    agg = LT.aggregate(state);
    renderToday();
    renderStats();
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
    var key = [view, state.dob, state.lifespan].join('|');
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

    plan.forEach(function (row) {
      html.push('<div class=row><span class=lbl>' + row.label + '</span><div class=cells>');

      for (var i = 0; i < row.count; i++) {
        var record = { age: row.startAge, idx: i, dateKey: null, future: false, el: null };

        if (view === 'years') {
          record.age = row.startAge + i;
          record.idx = 0;
        } else if (view === 'days') {
          record.dateKey = LT.toKey(LT.addDays(LT.anniversary(dob, row.startAge), i));
        }

        cells.push(record);
        html.push('<i data-i=' + index + '></i>');
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

    if (view === 'days') {
      var mark = state.entries[cell.dateKey];
      return prettyDate(cell.dateKey) + ' · age ' + cell.age + ' · ' +
        (mark === LT.GOOD ? 'good' : mark === LT.BAD ? 'rough' : cell.future ? 'ahead of you' : 'not logged');
    }

    if (view === 'years') {
      var year = agg.years[cell.age];
      return 'Age ' + cell.age + ' · ' + LT.anniversary(dob, cell.age).getFullYear() + ' · ' +
        tallyText(year, 'month');
    }

    if (view === 'weeks') {
      var week = agg.weeks[cell.age][cell.idx];
      var start = LT.addDays(LT.anniversary(dob, cell.age), cell.idx * 7);
      var end = cell.idx === LT.WEEKS_PER_YEAR - 1
        ? LT.addDays(LT.anniversary(dob, cell.age + 1), -1)
        : LT.addDays(start, 6);
      return 'Age ' + cell.age + ', week ' + (cell.idx + 1) + ' · ' +
        prettyDate(LT.toKey(start)) + ' – ' + prettyDate(LT.toKey(end)) + ' · ' +
        tallyText(week, 'day');
    }

    var month = agg.months[cell.age][cell.idx];
    var range = weekRangeForMonth(cell.idx);
    return 'Age ' + cell.age + ', month ' + (cell.idx + 1) +
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
    var label = bucket.mark === LT.TIE ? 'even split' : bucket.mark === LT.GOOD ? 'green' : 'red';
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

      var added = 0;
      var changed = 0;

      Object.keys(incoming.entries).forEach(function (key) {
        if (!(key in state.entries)) added++;
        else if (state.entries[key] !== incoming.entries[key]) changed++;
        state.entries[key] = incoming.entries[key];
      });

      if (!state.dob && incoming.dob) state.dob = incoming.dob;
      if (incoming.dob) el.dob.value = state.dob;

      builtKey = null;
      commit();
      say('Imported — ' + added + ' new, ' + changed + ' updated.');
    };

    reader.readAsText(file);
    e.target.value = '';
  }

  function resetAll() {
    if (!global.confirm('Erase your date of birth and every logged day? This cannot be undone.')) return;

    state = LT.defaultState();
    LT.save(state);

    el.dob.value = '';
    el.lifespan.value = state.lifespan;
    el.palette.checked = false;
    builtKey = null;

    render();
    say('Everything erased.');
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
