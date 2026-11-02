import {
  renderItemImages,
  renderAssistantMarkdown,
  agentMessageText
} from './rendering.js';
export function createProjectResources({
  container,
  search,
  state,
  t,
  reference,
  openImage,
  openChat,
  rpc,
  isCurrent
}) {
  let kind = 'library',
    path = '',
    cursor = null,
    source = 'project',
    historyOffset = 0,
    generation = 0;
  const node = (tag, text = '', className = '') => {
    const n = document.createElement(tag);
    n.textContent = text;
    n.className = className;
    return n;
  };
  const cwd = () =>
    state.active?.cwd || (state.projectless ? state.config.home : state.workspaceContext?.cwd || state.config.defaultCwd);
  function button(text, action) {
    const n = node('button', t(text), 'settings-action');
    n.type = 'button';
    n.onclick = action;
    return n;
  }
  function toolbar() {
    const bar = node('div', '', 'resource-toolbar');
    if (kind === 'images') {
      const select = node('select', '', 'settings-select');
      select.id = 'imageSource';
      select.setAttribute('aria-label', t('Image source'));
      select.append(
        new Option(t('Project images'), 'project'),
        new Option(t('Recent chat images'), 'history')
      );
      select.value = source;
      select.onchange = () => {
        source = select.value;
        historyOffset = 0;
        cursor = null;
        load();
      };
      bar.append(select);
    } else {
      if (path)
        bar.append(
          button('Up one folder', () => {
            path = path.split('/').slice(0, -1).join('/');
            cursor = null;
            load();
          })
        );
      const location = node('span', path || cwd(), 'resource-location');
      location.dataset.i18nIgnore = '';
      bar.append(location);
    }
    bar.append(
      button('Refresh', () => {
        historyOffset = 0;
        cursor = null;
        load();
      })
    );
    return bar;
  }
  function imageCard(src, title, file = '', threadId = '') {
    const article = node('article', '', 'resource-image-card'),
      preview = node('button');
    preview.type = 'button';
    preview.setAttribute('aria-label', t('View image: {title}', { title }));
    const image = node('img');
    image.src = src;
    image.alt = title;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.onerror = () => {
      preview.replaceChildren(node('span', t('Image unavailable')));
    };
    preview.append(image);
    preview.onclick = () => openImage(src, title, file);
    article.append(preview, node('small', title));
    if (threadId) article.append(button('Open chat', () => openChat(threadId)));
    return article;
  }
  async function previewFile(item, article) {
    const existing = article.querySelector('.resource-file-preview');
    if (existing) {
      existing.remove();
      return;
    }
    const preview = node('pre', t('Loading…'), 'resource-file-preview');
    article.append(preview);
    try {
      const response = await fetch(
        '/api/library/preview?' +
          new URLSearchParams({ path: `${cwd()}/${item.path}` })
      );
      const data = await response.json();
      if (!response.ok) throw new Error(response.status===404?'The server is older than this page. Update the running WebUI service.':'Files are unavailable. Check the project folder and access permissions.');
      preview.textContent = data.text; preview.dataset.i18nIgnore='';
    } catch {
      preview.textContent = t(
        'Preview unavailable. Download this file to open it.'
      );
    }
  }
  async function historyImages(grid, requestId, more) {
    if (!more) historyOffset = 0;
    const chats = state.threads.slice(historyOffset, historyOffset + 10);
    historyOffset += chats.length;
    for (let offset = 0; offset < chats.length; offset += 3) {
      const group = chats.slice(offset, offset + 3);
      const results = await Promise.allSettled(
        group.map((chat) =>
          rpc('thread/turns/list', {
            threadId: chat.id,
            limit: 20,
            sortDirection: 'desc',
            itemsView: 'full'
          })
        )
      );
      if (generation !== requestId || !isCurrent()) return;
      results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const chat = group[index],
          template = document.createElement('template');
        for (const turn of result.value.data || result.value.turns || [])
          for (const item of turn.items || []) {
            template.innerHTML =
              renderItemImages(item, { cwd: chat.cwd }) +
              (item.type === 'agentMessage'
                ? renderAssistantMarkdown(agentMessageText(item), {
                    cwd: chat.cwd
                  })
                : '');
            for (const image of template.content.querySelectorAll(
              '[data-image-src]'
            )) {
              const src = image.dataset.imageSrc;
              if (
                !src.startsWith('/api/images/local?') && !src.startsWith('/api/attachments/file?') &&
                !/^data:image\//.test(src)
              )
                continue;
              if (
                [...grid.children].some((card) => card.dataset.source === src)
              )
                continue;
              grid.querySelector('.workspace-feature-empty')?.remove();
              const card = imageCard(
                src,
                image.dataset.imageTitle || chat.name || t('Image'),
                image.dataset.imagePath || '',
                chat.id
              );
              card.dataset.source = src;
              grid.append(card);
            }
          }
      });
    }
    if (!grid.childElementCount)
      grid.append(node('p', t('No images found'), 'workspace-feature-empty'));
    if (historyOffset < state.threads.length)
      container.append(
        button('Load more chats', () => {
          container.lastElementChild.remove();
          load(true);
        })
      );
  }
  async function load(more = false) {
    const requestId = ++generation;
    if (!more) {
      container.replaceChildren(toolbar());
      container.append(node('p', t('Loading…'), 'resource-status'));
    }
    try {
      if (kind === 'images' && source === 'history') {
        let grid = container.querySelector('.workspace-image-grid');
        if (!grid) {
          grid = node('div', '', 'workspace-image-grid');
          container.append(grid);
        }
        await historyImages(grid, requestId, more);
        return;
      }
      const response = await fetch(
        '/api/library?' +
          new URLSearchParams({
            cwd: cwd(),
            path,
            query: search.value.trim(),
            images: String(kind === 'images'),
            cursor: String(more ? cursor || 0 : 0)
          }),
        { cache: 'no-store' }
      );
      if (!response.ok) throw new Error(response.status===404?'The server is older than this page. Update the running WebUI service.':'Files are unavailable. Check the project folder and access permissions.');
      const result = await response.json();
      if (generation !== requestId || !isCurrent()) return;
      let list = container.querySelector('.resource-list');
      if (!list) {
        list = node(
          'div',
          '',
          kind === 'images'
            ? 'resource-list workspace-image-grid'
            : 'resource-list'
        );
        container.append(list);
      }
      if(kind==='images'&&!more) {
        const uploaded=await fetch('/api/attachments?'+new URLSearchParams({cwd:cwd()})).then(response=>response.ok?response.json():{items:[]});
        if(generation!==requestId||!isCurrent())return;
        for(const item of uploaded.items.filter(item=>item.image&&item.name.toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase())))list.append(imageCard('/api/attachments/file?'+new URLSearchParams({id:item.id,view:'image'}),item.name));
      }
      for (const item of result.items) {
        if (kind === 'images') {
          list.append(
            imageCard(
              '/api/images/local?' +
                new URLSearchParams({ cwd: cwd(), path: item.path }),
              item.path,
              `${cwd()}/${item.path}`
            )
          );
          continue;
        }
        const article = node('article', '', 'workspace-resource-card');
        const title=node('h2',item.path);title.dataset.i18nIgnore='';article.append(title);
        if (item.kind === 'folder')
          article.append(
            button('Open folder', () => {
              path = item.path;
              cursor = null;
              load();
            })
          );
        else {
          article.append(
            node(
              'p',
              `${new Intl.NumberFormat(document.documentElement.lang).format(item.bytes)} B`
            ),
            button('Reference in chat', () => reference(`@${item.path}`))
          );
          if (item.downloadable) {
            article.append(button('Preview', () => previewFile(item, article)));
            const link = node('a', t('Download'), 'settings-action');
            link.href =
              '/api/files/download?' +
              new URLSearchParams({
                cwd: cwd(),
                path: `${cwd()}/${item.path}`
              });
            link.download = item.name;
            article.append(link);
          }
        }
        list.append(article);
      }
      if (!list.childElementCount)
        list.append(
          node(
            'p',
            t(kind === 'images' ? 'No images found' : 'No matching resources'),
            'workspace-feature-empty'
          )
        );
      cursor = result.nextCursor;
      if (result.partial)
        container.append(
          node(
            'p',
            t('Some files were omitted because the scan limit was reached.'),
            'settings-note'
          )
        );
      container.querySelector('[data-resource-more]')?.remove();
      if (cursor !== null) {
        const more = button('Load more', () => load(true));
        more.dataset.resourceMore = '';
        container.append(more);
      }
    } catch (error) {
      if (generation === requestId && isCurrent())
        container.append(
          node('p', t(error.message||'File search unavailable'), 'settings-note')
        );
    } finally {
      if (generation === requestId)
        container.querySelector('.resource-status')?.remove();
    }
  }
  return {
    open(value) {
      kind = value;
      path = '';
      cursor = null;
      source = 'project';
      historyOffset = 0;
      return load();
    },
    search() {
      path = '';
      cursor = null;
      return load();
    },
    close() {
      generation++;
    }
  };
}
