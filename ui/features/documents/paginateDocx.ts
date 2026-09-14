// Paginate only sanitized, laid-out content in the isolated preview frame.
export function paginateDocx(document: Document) {
  const view = document.defaultView;
  if (!view) {
    return;
  }

  function splitParagraph(paragraph: Element, bottom: number): Element | null {
    const walker = document.createTreeWalker(paragraph, 4);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const range = document.createRange();
      range.selectNodeContents(node);
      if (range.getBoundingClientRect().bottom <= bottom + 1) {
        continue;
      }
      let low = 0;
      let high = node.textContent?.length ?? 0;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        range.setStart(node, middle);
        range.setEnd(node, middle + 1);
        if (range.getBoundingClientRect().bottom <= bottom + 1) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      range.setStart(node, low);
      range.setEndAfter(paragraph.lastChild!);
      const prefix = document.createRange();
      prefix.selectNodeContents(paragraph);
      prefix.setEnd(node, low);
      if (!prefix.toString().trim()) {
        return null;
      }
      const continuation = paragraph.cloneNode(false) as Element;
      continuation.removeAttribute('id');
      continuation.append(range.extractContents());
      return continuation;
    }
    return null;
  }

  function splitTable(table: Element, bottom: number): Element | null {
    const rows = Array.from(table.querySelectorAll(':scope > tbody > tr, :scope > tr'));
    const firstOverflow = rows.findIndex((row) => row.getBoundingClientRect().bottom > bottom + 1);
    // Keep merged rows together; unusually tall rows remain fully readable.
    if (firstOverflow <= 0 || table.querySelector('[rowspan]:not([rowspan="1"])')) {
      return null;
    }
    const range = document.createRange();
    range.setStartBefore(rows[firstOverflow]);
    range.setEndAfter(table.lastChild!);
    const continuation = table.cloneNode(false) as Element;
    continuation.removeAttribute('id');
    for (const heading of table.querySelectorAll(':scope > colgroup, :scope > thead')) {
      continuation.append(heading.cloneNode(true));
    }
    continuation.append(range.extractContents());
    return continuation;
  }

  for (const original of document.querySelectorAll<HTMLElement>('section.docx')) {
    let page = original;
    const style = view.getComputedStyle(page);
    const height = Number.parseFloat(style.minHeight);
    if (!(height > 0)) {
      continue;
    }
    const bottomPadding = Number.parseFloat(style.paddingBottom);
    const articles = Array.from(page.querySelectorAll<HTMLElement>(':scope > article'));
    const blocks = articles.flatMap((article) =>
      Array.from(article.children, (block) => ({ block, article })),
    );
    if (!blocks.length) {
      continue;
    }
    const template = page.cloneNode(true) as HTMLElement;
    for (const article of template.querySelectorAll(':scope > article')) {
      article.replaceChildren();
    }
    for (const article of articles) {
      article.replaceChildren();
    }
    let target = articles[0];
    let source = target;

    const nextPage = () => {
      const next = template.cloneNode(true) as HTMLElement;
      // Notes belong to the original page; don't duplicate them on continuation pages.
      for (const notes of next.querySelectorAll(':scope > ol')) {
        notes.remove();
      }
      page.after(next);
      page = next;
      target = page.querySelector<HTMLElement>('article')!;
      target.style.cssText = source.style.cssText;
    };
    const bottom = () => {
      const trailingHeight = Array.from(
        page.querySelectorAll(':scope > footer, :scope > ol'),
      ).reduce((total, element) => total + element.getBoundingClientRect().height, 0);
      return page.getBoundingClientRect().top + height - bottomPadding - trailingHeight;
    };

    for (const { block, article } of blocks) {
      if (source !== article) {
        const nextArticle = article.cloneNode(false) as HTMLElement;
        target.after(nextArticle);
        target = nextArticle;
      }
      source = article;
      target.style.cssText = source.style.cssText;
      target.append(block);
      if (block.getBoundingClientRect().bottom <= bottom() + 1) {
        continue;
      }
      if (target.children.length > 1) {
        block.remove();
        nextPage();
        target.append(block);
      }
      // Oversized indivisible objects retain their full content on an expanded page.
      const split = block.tagName === 'P' ? splitParagraph : splitTable;
      let remainder = block;
      while (
        ['P', 'TABLE'].includes(remainder.tagName) &&
        remainder.getBoundingClientRect().bottom > bottom() + 1
      ) {
        const continuation = split(remainder, bottom());
        if (!continuation) {
          break;
        }
        nextPage();
        target.append(continuation);
        remainder = continuation;
      }
    }
  }
}
