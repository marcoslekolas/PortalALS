/* ════════════════════════════════════════════════════════════════════
   select-enhancer.js — Portal ALS / Customs Way
   --------------------------------------------------------------------
   Convierte cada <select> en un buscador: se puede escribir para filtrar
   las opciones, y si no se escribe funciona como un desplegable normal.

   CLAVE DE SEGURIDAD: el <select> nativo se MANTIENE (oculto) y sincronizado.
   Todo el código existente que lee/escribe `.value`, usa `gv()`, dispara
   `onchange`, o rellena <option> dinámicamente sigue funcionando igual.

   Para excluir un select concreto: añádele el atributo  data-no-enh
   ════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__selEnhLoaded) return;
  window.__selEnhLoaded = true;

  function css(el, s) { el.style.cssText = s; }

  function enhanceSelect(sel) {
    try {
      if (!sel || sel.tagName !== 'SELECT') return;
      if (sel.multiple) return;                         // multi-select: no tocar
      if (sel.dataset.enh === '1') return;              // ya enriquecido
      if (sel.hasAttribute('data-no-enh')) return;      // opt-out explícito
      if (sel.closest('[data-no-enh]')) return;
      sel.dataset.enh = '1';

      // ── Wrapper ────────────────────────────────────────────────────
      var wrap = document.createElement('div');
      wrap.className = 'sel-enh';
      css(wrap, 'position:relative;display:block');
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
      sel.style.display = 'none';                        // ocultar nativo (sigue funcional)

      // ── Input visible (hereda el aspecto del select) ───────────────
      var input = document.createElement('input');
      input.type = 'text';
      input.className = sel.className;
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('spellcheck', 'false');
      input.style.backgroundImage = 'none';
      input.style.paddingRight = '26px';
      input.style.cursor = 'text';
      if (sel.disabled) input.disabled = true;
      input.placeholder = sel.getAttribute('data-ph') || 'Escribe o elige…';
      wrap.appendChild(input);

      // ── Flecha ─────────────────────────────────────────────────────
      var arrow = document.createElement('span');
      arrow.textContent = '▾';
      css(arrow, 'position:absolute;right:9px;top:50%;transform:translateY(-50%);pointer-events:none;color:var(--g500,#64748b);font-size:11px');
      wrap.appendChild(arrow);

      // ── Lista (se ancla al <body> para no ser recortada por overflow) ─
      var list = document.createElement('div');
      list.className = 'sel-enh-list';
      css(list, 'position:fixed;z-index:100000;background:var(--w,#fff);border:1px solid var(--g300,#cbd5e1);border-radius:8px;max-height:240px;overflow-y:auto;box-shadow:0 8px 28px rgba(0,0,0,.15);display:none');
      document.body.appendChild(list);

      var hiIdx = -1;   // índice resaltado por teclado (dentro de la lista visible)

      function currentLabel() {
        var o = sel.options[sel.selectedIndex];
        return o ? o.textContent : '';
      }
      function syncInput() { if (document.activeElement !== input) input.value = currentLabel(); }

      function position() {
        var r = input.getBoundingClientRect();
        list.style.left = r.left + 'px';
        list.style.width = r.width + 'px';
        var lh = Math.min(240, list.scrollHeight || 240);
        if (r.bottom + 2 + lh > window.innerHeight && r.top - 2 - lh > 0) {
          list.style.top = (r.top - 2 - lh) + 'px';       // abrir hacia arriba
        } else {
          list.style.top = (r.bottom + 2) + 'px';
        }
      }

      function build(filter) {
        list.innerHTML = '';
        hiIdx = -1;
        var f = (filter || '').trim().toLowerCase();
        var count = 0;
        for (var i = 0; i < sel.options.length; i++) {
          var o = sel.options[i];
          var txt = o.textContent || '';
          if (f && txt.toLowerCase().indexOf(f) < 0) continue;
          var item = document.createElement('div');
          item.className = 'sel-enh-item';
          item.textContent = txt || '\u00A0';
          item.setAttribute('data-idx', String(i));
          css(item, 'padding:8px 10px;cursor:pointer;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
            (i === sel.selectedIndex ? 'background:var(--b50,#eff6ff);font-weight:600' : ''));
          item.addEventListener('mouseenter', mkEnter(item));
          item.addEventListener('mousedown', mkPick(i));
          list.appendChild(item);
          count++;
        }
        if (!count) {
          var none = document.createElement('div');
          css(none, 'padding:8px 10px;color:var(--g400,#94a3b8);font-size:12px');
          none.textContent = 'Sin coincidencias';
          list.appendChild(none);
        }
      }
      function mkEnter(item) { return function () { clearHi(); item.style.background = 'var(--b100,#dbeafe)'; hiIdx = visibleItems().indexOf(item); }; }
      function mkPick(i) { return function (ev) { ev.preventDefault(); pick(i); }; }

      function visibleItems() { return Array.prototype.slice.call(list.querySelectorAll('.sel-enh-item')); }
      function clearHi() {
        visibleItems().forEach(function (it) {
          var idx = parseInt(it.getAttribute('data-idx'), 10);
          it.style.background = (idx === sel.selectedIndex) ? 'var(--b50,#eff6ff)' : '';
        });
      }
      function moveHi(delta) {
        var items = visibleItems();
        if (!items.length) return;
        hiIdx += delta;
        if (hiIdx < 0) hiIdx = items.length - 1;
        if (hiIdx >= items.length) hiIdx = 0;
        clearHi();
        items[hiIdx].style.background = 'var(--b100,#dbeafe)';
        items[hiIdx].scrollIntoView({ block: 'nearest' });
      }

      var open = false;
      function openList() {
        if (open || input.disabled) return;
        open = true;
        build('');
        list.style.display = 'block';
        position();
        input.select();
        window.addEventListener('scroll', onScroll, true);
        window.addEventListener('resize', position);
      }
      function closeList() {
        if (!open) return;
        open = false;
        list.style.display = 'none';
        window.removeEventListener('scroll', onScroll, true);
        window.removeEventListener('resize', position);
        syncInput();                                     // revierte a la selección real
      }
      function onScroll() { if (open) position(); }

      function pick(i) {
        if (i < 0 || i >= sel.options.length) { closeList(); return; }
        if (sel.selectedIndex !== i) {
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('input', { bubbles: true }));
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        input.value = currentLabel();
        closeList();
      }

      input.addEventListener('focus', openList);
      input.addEventListener('mousedown', function () { if (!open) setTimeout(openList, 0); });
      input.addEventListener('input', function () { if (!open) openList(); build(input.value); position(); });
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); if (!open) openList(); else moveHi(1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); moveHi(-1); }
        else if (ev.key === 'Enter') {
          var items = visibleItems();
          if (open && items.length) {
            ev.preventDefault();
            var target = (hiIdx >= 0 && items[hiIdx]) ? items[hiIdx] : items[0];
            pick(parseInt(target.getAttribute('data-idx'), 10));
          }
        } else if (ev.key === 'Escape') { if (open) { ev.stopPropagation(); closeList(); } }
        else if (ev.key === 'Tab') { closeList(); }
      });
      input.addEventListener('blur', function () { setTimeout(closeList, 120); });

      // Cerrar al clicar fuera
      document.addEventListener('mousedown', function (ev) {
        if (open && !wrap.contains(ev.target) && !list.contains(ev.target)) closeList();
      });

      // Si el código cambia el valor por su cuenta (sin evento), reflejarlo:
      sel.addEventListener('change', function () { input.value = currentLabel(); });
      try {
        var proto = window.HTMLSelectElement && HTMLSelectElement.prototype;
        var dV = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        var dI = proto && Object.getOwnPropertyDescriptor(proto, 'selectedIndex');
        if (dV && dV.set) {
          Object.defineProperty(sel, 'value', {
            configurable: true,
            get: function () { return dV.get.call(this); },
            set: function (v) { dV.set.call(this, v); input.value = currentLabel(); }
          });
        }
        if (dI && dI.set) {
          Object.defineProperty(sel, 'selectedIndex', {
            configurable: true,
            get: function () { return dI.get.call(this); },
            set: function (v) { dI.set.call(this, v); input.value = currentLabel(); }
          });
        }
      } catch (e) { /* si el navegador no lo permite, seguimos: syncInput en focus lo cubre */ }

      // Reflejar cambios de opciones (selects que se rellenan dinámicamente)
      try {
        new MutationObserver(function () {
          input.value = currentLabel();
          if (open) build(input.value);
        }).observe(sel, { childList: true });
      } catch (e) { /* opcional */ }

      // Reflejar disabled
      try {
        new MutationObserver(function () { input.disabled = sel.disabled; })
          .observe(sel, { attributes: true, attributeFilter: ['disabled'] });
      } catch (e) { /* opcional */ }

      input.value = currentLabel();
    } catch (e) {
      // Nunca romper la página por el enriquecedor
      try { console.warn('select-enhancer:', e && e.message); } catch (_) {}
    }
  }

  function enhanceAll(root) {
    try {
      (root || document).querySelectorAll('select:not([data-enh])').forEach(enhanceSelect);
    } catch (e) { /* noop */ }
  }

  function boot() {
    enhanceAll(document);
    try {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var added = muts[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            var n = added[j];
            if (!n || n.nodeType !== 1) continue;
            if (n.tagName === 'SELECT') enhanceSelect(n);
            else if (n.querySelectorAll) {
              var inner = n.querySelectorAll('select:not([data-enh])');
              for (var k = 0; k < inner.length; k++) enhanceSelect(inner[k]);
            }
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) { /* noop */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.enhanceSelects = enhanceAll;   // por si se quiere invocar manualmente
})();
