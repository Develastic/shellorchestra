// SPDX-FileCopyrightText: 2026 Mykola Rudenko
// SPDX-License-Identifier: LicenseRef-ShellOrchestra-Source-Available-1.0
// ShellOrchestra is source-available, not open source. See LICENSE.md and https://shellorchestra.com/legal/license/.
// Commercial distribution: Develastic, s. r. o.

(function () {
  function closestCopyTarget(node) {
    while (node && node.nodeType === 1) {
      if (node.getAttribute && node.getAttribute('data-copy-url')) return node;
      node = node.parentNode;
    }
    return null;
  }

  function postCopy(target) {
    var url = target && target.getAttribute ? target.getAttribute('data-copy-url') : '';
    if (!url) return;
    window.parent.postMessage({ type: 'shellorchestra-preview-copy-url', url: url }, '*');
  }

  document.addEventListener('click', function (event) {
    var target = closestCopyTarget(event.target);
    if (!target) return;
    event.preventDefault();
    postCopy(target);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    var target = closestCopyTarget(event.target);
    if (!target) return;
    event.preventDefault();
    postCopy(target);
  });
}());
