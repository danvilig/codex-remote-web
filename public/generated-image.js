import { renderItemImages } from './rendering.js';

export function updateGeneratedImage(container, item, cwd, t) {
  const images = renderItemImages(item, { cwd, className: 'generated-image-grid' });
  if (images) {
    if (container.dataset.images === images) return;
    container.classList.toggle('generated-image-reveal', container.dataset.pending === 'true');
    container.dataset.images = images;
    delete container.dataset.pending;
    container.innerHTML = images;
    return;
  }
  const active = item.status === 'inProgress' || item.status === 'running';
  const label = t(active ? 'Generating image' : item.status === 'failed' ? 'Image generation failed' : 'Image unavailable');
  container.dataset.pending = String(active);
  delete container.dataset.images;
  container.classList.remove('generated-image-reveal');
  let status = container.querySelector('.generated-image-pending');
  if (!status) {
    status = document.createElement('div');
    status.className = 'generated-image-pending';
    status.role = 'status';
    const caption = document.createElement('span');
    caption.className = 'generated-image-pending-label';
    status.append(caption);
    container.replaceChildren(status);
  }
  const caption = status.firstElementChild;
  if (caption.textContent !== label) caption.textContent = label;
}
