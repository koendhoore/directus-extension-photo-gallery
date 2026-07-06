<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useApi, useStores } from '@directus/extensions-sdk';
import Sortable from 'sortablejs';
import Cropper from 'cropperjs';

interface DirectusFile {
	id: string;
	title?: string | null;
	description?: string | null;
	tags?: string[] | null;
	location?: string | null;
	storage?: string | null;
	type?: string | null;
	filename_download?: string | null;
	width?: number | null;
	height?: number | null;
	filesize?: number | string | null;
}

interface GalleryItem {
	key: string;
	junctionId: string | number | null;
	fileId: string;
	file: DirectusFile;
	isNew: boolean;
	rev: number;
	sort: number;
}

const props = withDefaults(
	defineProps<{
		value?: Record<string, unknown> | unknown[] | null;
		collection: string;
		field: string;
		primaryKey: string | number;
		disabled?: boolean;
		folder?: string | null;
		thumbnailFit?: string;
	}>(),
	{ value: null, disabled: false, folder: null, thumbnailFit: 'cover' }
);

const emit = defineEmits<{ (e: 'input', value: Record<string, unknown> | null): void }>();

const api = useApi();
const { useRelationsStore } = useStores();
const relationsStore = useRelationsStore();

/* ----------------------------- Relation ----------------------------- */

const relationInfo = computed(() => {
	const relations = relationsStore.getRelationsForField(props.collection, props.field) as any[];
	const junction = relations.find(
		(r) => r.related_collection === props.collection && r.meta && r.meta.one_field === props.field
	);
	if (!junction) return null;
	return {
		junctionCollection: junction.collection as string,
		reverseField: junction.field as string,
		junctionField: junction.meta.junction_field as string,
		sortField: (junction.meta.sort_field as string) || null,
	};
});

const hasSortField = computed(() => !!relationInfo.value?.sortField);

/* ------------------------------ State ------------------------------- */

const items = ref<GalleryItem[]>([]);
const deletedJunctionIds = ref<(string | number)[]>([]);
const selected = ref<Set<string>>(new Set());

const loading = ref(false);
const loadedFor = ref<string | number | null>(null);

const dialogActive = ref(false);
const uploading = ref(false);
const uploadProgress = ref(0);
const deleting = ref(false);
const busy = computed(() => uploading.value || deleting.value);

/* Transient status message shown in the header (green = ok, red = error). */
const statusMsg = ref('');
const statusType = ref<'success' | 'error'>('success');
let statusTimer: ReturnType<typeof setTimeout> | null = null;

let tempCounter = 0;
const nextTempKey = () => `new-${Date.now()}-${tempCounter++}`;

const count = computed(() => items.value.length);
const isNewItem = computed(() => props.primaryKey === '+' || props.primaryKey == null);
const immediate = computed(() => !isNewItem.value && !!relationInfo.value);

/* --------------------------- Tile sizing ---------------------------- */

const SIZES = [
	{ key: 's', min: 110 },
	{ key: 'm', min: 150 },
	{ key: 'l', min: 200 },
	{ key: 'xl', min: 270 },
];
const tileSize = ref<string>(loadSizePref());
const tileMin = computed(() => (SIZES.find((s) => s.key === tileSize.value) ?? SIZES[1]).min);

function loadSizePref() {
	try {
		return localStorage.getItem('pg-tile-size') || 'm';
	} catch {
		return 'm';
	}
}
function setTileSize(key: string) {
	tileSize.value = key;
	try {
		localStorage.setItem('pg-tile-size', key);
	} catch {
		/* ignore */
	}
}

/* --------------------------- Load existing -------------------------- */

async function loadExisting() {
	const info = relationInfo.value;
	if (!info) return;

	if (isNewItem.value) {
		items.value = [];
		applyIncomingValue();
		loadedFor.value = props.primaryKey;
		return;
	}

	loading.value = true;
	try {
		const jf = info.junctionField;
		const fields = ['id'];
		if (info.sortField) fields.push(info.sortField);
		fields.push(
			`${jf}.id`,
			`${jf}.title`,
			`${jf}.type`,
			`${jf}.filename_download`,
			`${jf}.width`,
			`${jf}.height`,
			`${jf}.filesize`
		);

		const res = await api.get(`/items/${info.junctionCollection}`, {
			params: {
				filter: { [info.reverseField]: { _eq: props.primaryKey } },
				fields,
				sort: info.sortField ? [info.sortField, 'id'] : ['id'],
				limit: -1,
			},
		});

		const rows = (res.data?.data ?? []) as any[];
		items.value = rows
			.filter((row) => row[jf])
			.map((row, index) => {
				const file = (typeof row[jf] === 'object' ? row[jf] : { id: row[jf] }) as DirectusFile;
				const sort = info.sortField && typeof row[info.sortField] === 'number' ? row[info.sortField] : index + 1;
				return { key: `j-${row.id}`, junctionId: row.id, fileId: file.id, file, isNew: false, rev: 0, sort } as GalleryItem;
			});

		deletedJunctionIds.value = [];
		applyIncomingValue();
		loadedFor.value = props.primaryKey;
	} catch (err) {
		notify('Could not load gallery items', 'error');
		// eslint-disable-next-line no-console
		console.error('[photo-gallery] load failed', err);
	} finally {
		loading.value = false;
	}
}

function applyIncomingValue() {
	const info = relationInfo.value;
	if (!info || !props.value || Array.isArray(props.value)) return;
	const val = props.value as any;
	if (Array.isArray(val.delete)) {
		for (const id of val.delete) {
			deletedJunctionIds.value.push(id);
			items.value = items.value.filter((it) => it.junctionId !== id);
		}
	}
	if (Array.isArray(val.create)) {
		for (const entry of val.create) {
			const rel = entry?.[info.junctionField];
			const fileId = typeof rel === 'object' ? rel?.id : rel;
			if (!fileId) continue;
			if (items.value.some((it) => it.fileId === fileId && it.isNew)) continue;
			items.value.push({
				key: nextTempKey(),
				junctionId: null,
				fileId,
				file: { id: fileId },
				isNew: true,
				rev: 0,
				sort: items.value.length + 1,
			});
		}
	}
}

/* ------------------- Staged value (new parent only) ----------------- */

function emitValue() {
	const info = relationInfo.value;
	if (!info) return;
	const sortField = info.sortField;
	const create: Record<string, unknown>[] = [];
	const update: Record<string, unknown>[] = [];

	items.value.forEach((it, index) => {
		const sortVal = index + 1;
		if (it.junctionId == null) {
			const entry: Record<string, unknown> = { [info.junctionField]: { id: it.fileId } };
			if (sortField) entry[sortField] = sortVal;
			create.push(entry);
		} else if (sortField) {
			update.push({ id: it.junctionId, [sortField]: sortVal });
		}
	});

	const del = [...deletedJunctionIds.value];
	if (create.length === 0 && update.length === 0 && del.length === 0) {
		emit('input', null);
		return;
	}
	const payload: Record<string, unknown> = {};
	if (create.length) payload.create = create;
	if (update.length) payload.update = update;
	if (del.length) payload.delete = del;
	emit('input', payload);
}

/* ----------------------- Add / link a file -------------------------- */

async function linkFile(file: DirectusFile) {
	const info = relationInfo.value;
	if (!info) return;
	const nextSort = items.value.length + 1;

	if (immediate.value) {
		try {
			const payload: Record<string, unknown> = {
				[info.reverseField]: props.primaryKey,
				[info.junctionField]: file.id,
			};
			if (info.sortField) payload[info.sortField] = nextSort;
			const res = await api.post(`/items/${info.junctionCollection}`, payload, { params: { fields: ['id'] } });
			const junctionId = res.data?.data?.id;
			items.value.push({ key: `j-${junctionId}`, junctionId, fileId: file.id, file, isNew: false, rev: 0, sort: nextSort });
		} catch (err) {
			notify('Could not add file to gallery', 'error');
			// eslint-disable-next-line no-console
			console.error('[photo-gallery] link failed', err);
		}
	} else {
		items.value.push({ key: nextTempKey(), junctionId: null, fileId: file.id, file, isNew: true, rev: 0, sort: nextSort });
		emitValue();
	}
}

/* ----------------------------- Reorder ------------------------------ */

function moveInArray(oldIndex: number, newIndex: number) {
	const arr = items.value.slice();
	const [moved] = arr.splice(oldIndex, 1);
	if (!moved) return;
	arr.splice(newIndex, 0, moved);
	items.value = arr;
	if (immediate.value) void persistSort();
	else emitValue();
}

async function persistSort() {
	const info = relationInfo.value;
	if (!info?.sortField || !immediate.value) return;
	const changed: { id: string | number; sort: number }[] = [];
	items.value.forEach((it, i) => {
		const s = i + 1;
		if (it.junctionId != null && it.sort !== s) {
			it.sort = s;
			changed.push({ id: it.junctionId, sort: s });
		}
	});
	if (changed.length === 0) return;
	try {
		await Promise.all(
			changed.map((c) => api.patch(`/items/${info.junctionCollection}/${c.id}`, { [info.sortField as string]: c.sort }))
		);
		notify('Photo order updated');
	} catch (err) {
		notify('Could not save the new order', 'error');
		// eslint-disable-next-line no-console
		console.error('[photo-gallery] reorder save failed', err);
	}
}

/* --------------------- Selection + bulk actions --------------------- */

const allSelected = computed(() => items.value.length > 0 && selected.value.size === items.value.length);
const someSelected = computed(() => selected.value.size > 0);
const selectedItems = computed(() => items.value.filter((it) => selected.value.has(it.key)));

function toggleSelect(item: GalleryItem) {
	const next = new Set(selected.value);
	if (next.has(item.key)) next.delete(item.key);
	else next.add(item.key);
	selected.value = next;
}
function toggleSelectAll() {
	if (allSelected.value) selected.value = new Set();
	else selected.value = new Set(items.value.map((it) => it.key));
}
function clearSelection() {
	selected.value = new Set();
}

/* Confirmation modal */
const confirmActive = ref(false);
const confirmTargets = ref<GalleryItem[]>([]);
const confirmCount = computed(() => confirmTargets.value.length);
function requestDelete(targets: GalleryItem[]) {
	if (targets.length === 0) return;
	confirmTargets.value = targets;
	confirmActive.value = true;
}
const confirmMessage = computed(() =>
	confirmCount.value === 1
		? 'Are you sure you want to delete this item? This action can not be undone.'
		: `Are you sure you want to delete these ${confirmCount.value} items? This action can not be undone.`
);

/** Hard-delete the target files from Directus. */
async function performDelete() {
	const info = relationInfo.value;
	const targets = confirmTargets.value;
	confirmActive.value = false;
	if (targets.length === 0 || !info) return;

	deleting.value = true;
	try {
		const fileIds = targets.map((t) => t.fileId);
		const junctionIds = targets.filter((t) => t.junctionId != null).map((t) => t.junctionId);

		await api.delete('/files', { data: fileIds });
		if (junctionIds.length) {
			try {
				await api.delete(`/items/${info.junctionCollection}`, { data: junctionIds });
			} catch {
				/* already removed via cascade */
			}
		}

		const removedKeys = new Set(targets.map((t) => t.key));
		items.value = items.value.filter((it) => !removedKeys.has(it.key));
		const removedJunctionIds = new Set(junctionIds);
		deletedJunctionIds.value = deletedJunctionIds.value.filter((id) => !removedJunctionIds.has(id));
		selected.value = new Set();
		if (immediate.value) void persistSort();
		else emitValue();
		notify(`Deleted ${fileIds.length} file${fileIds.length === 1 ? '' : 's'}`);
	} catch (err) {
		notify('Could not delete files', 'error');
		// eslint-disable-next-line no-console
		console.error('[photo-gallery] delete failed', err);
	} finally {
		deleting.value = false;
		confirmTargets.value = [];
	}
}

function downloadFiles(list: GalleryItem[]) {
	const base = (api.defaults.baseURL || '').replace(/\/$/, '');
	const token = authToken();
	list.forEach((it, i) => {
		const q = ['download'];
		if (token) q.push(`access_token=${encodeURIComponent(token)}`);
		const url = `${base}/assets/${it.fileId}?${q.join('&')}`;
		setTimeout(() => {
			const a = document.createElement('a');
			a.href = url;
			a.rel = 'noopener';
			a.download = it.file.filename_download || '';
			document.body.appendChild(a);
			a.click();
			a.remove();
		}, i * 250);
	});
}

/* --------------------------- Context menu --------------------------- */

const menuOpen = ref(false);
const menuItem = ref<GalleryItem | null>(null);
const menuPos = reactive({ x: 0, y: 0 });

function openMenu(item: GalleryItem, ev: MouseEvent) {
	menuItem.value = item;
	const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
	const menuW = 210;
	const menuH = 196;
	let x = rect.right - menuW;
	let y = rect.bottom + 6;
	if (y + menuH > window.innerHeight) y = rect.top - menuH - 6;
	if (x < 8) x = 8;
	if (x + menuW > window.innerWidth - 8) x = window.innerWidth - menuW - 8;
	menuPos.x = x;
	menuPos.y = y;
	menuOpen.value = true;
}
function closeMenu() {
	menuOpen.value = false;
	menuItem.value = null;
}
function menuAction(action: 'info' | 'image' | 'download' | 'delete') {
	const item = menuItem.value;
	closeMenu();
	if (!item) return;
	if (action === 'info') openInfo(item);
	else if (action === 'image') openImage(item);
	else if (action === 'download') downloadFiles([item]);
	else if (action === 'delete') requestDelete([item]);
}

/* ----------------------- Edit info side panel ----------------------- */

const infoActive = ref(false);
const infoItem = ref<GalleryItem | null>(null);
const infoLoading = ref(false);
const infoSaving = ref(false);
const infoMeta = ref<DirectusFile | null>(null);
const infoForm = reactive({ title: '', description: '', tags: [] as string[], location: '' });
const infoNewTag = ref('');
const infoReplaceInput = ref<HTMLInputElement | null>(null);

async function openInfo(item: GalleryItem) {
	infoItem.value = item;
	infoActive.value = true;
	infoLoading.value = true;
	infoNewTag.value = '';
	try {
		const res = await api.get(`/files/${item.fileId}`, {
			params: {
				fields: ['id', 'title', 'description', 'tags', 'location', 'storage', 'type', 'filename_download', 'width', 'height', 'filesize'],
			},
		});
		const f = res.data?.data as DirectusFile;
		infoMeta.value = f;
		infoForm.title = f.title ?? '';
		infoForm.description = f.description ?? '';
		infoForm.tags = Array.isArray(f.tags) ? [...f.tags] : [];
		infoForm.location = f.location ?? '';
	} catch (err) {
		notify('Could not load file details', 'error');
		// eslint-disable-next-line no-console
		console.error('[photo-gallery] info load failed', err);
	} finally {
		infoLoading.value = false;
	}
}
function closeInfo() {
	if (infoSaving.value) return;
	infoActive.value = false;
	infoItem.value = null;
	infoMeta.value = null;
}
function addInfoTag() {
	const t = infoNewTag.value.trim();
	if (t && !infoForm.tags.includes(t)) infoForm.tags.push(t);
	infoNewTag.value = '';
}
function removeInfoTag(t: string) {
	infoForm.tags = infoForm.tags.filter((x) => x !== t);
}
async function saveInfo() {
	if (!infoItem.value) return;
	infoSaving.value = true;
	try {
		const payload = {
			title: infoForm.title || null,
			description: infoForm.description || null,
			tags: infoForm.tags,
			location: infoForm.location || null,
		};
		const res = await api.patch(`/files/${infoItem.value.fileId}`, payload, {
			params: { fields: ['id', 'title', 'type', 'filename_download', 'width', 'height', 'filesize'] },
		});
		patchLocalFile(infoItem.value.key, res.data?.data ?? {});
		notify('File saved');
		infoActive.value = false;
	} catch (err) {
		notify('Could not save file', 'error');
		// eslint-disable-next-line no-console
		console.error('[photo-gallery] info save failed', err);
	} finally {
		infoSaving.value = false;
	}
}
function pickReplace() {
	infoReplaceInput.value?.click();
}
async function onReplacePicked(e: Event) {
	const input = e.target as HTMLInputElement;
	const file = input.files?.[0];
	input.value = '';
	if (!file || !infoItem.value) return;
	infoSaving.value = true;
	try {
		const form = new FormData();
		form.append('file', file);
		const res = await api.patch(`/files/${infoItem.value.fileId}`, form, {
			params: { fields: ['id', 'title', 'type', 'filename_download', 'width', 'height', 'filesize'] },
		});
		const f = res.data?.data as DirectusFile;
		infoMeta.value = { ...(infoMeta.value ?? {}), ...f } as DirectusFile;
		patchLocalFile(infoItem.value.key, f, true);
		notify('File replaced');
	} catch (err) {
		notify('Could not replace file', 'error');
		// eslint-disable-next-line no-console
		console.error('[photo-gallery] replace failed', err);
	} finally {
		infoSaving.value = false;
	}
}

function patchLocalFile(key: string, f: Partial<DirectusFile>, bumpRev = false) {
	const idx = items.value.findIndex((it) => it.key === key);
	if (idx === -1) return;
	const cur = items.value[idx];
	items.value.splice(idx, 1, { ...cur, file: { ...cur.file, ...f }, rev: bumpRev ? cur.rev + 1 : cur.rev });
}

/* ------------------------- Edit image editor ------------------------ */

const imageActive = ref(false);
const imageItem = ref<GalleryItem | null>(null);
const imageSaving = ref(false);
const imageEl = ref<HTMLImageElement | null>(null);
let cropper: Cropper | null = null;
let flipX = 1;
let flipY = 1;

async function openImage(item: GalleryItem) {
	imageItem.value = item;
	imageActive.value = true;
	flipX = 1;
	flipY = 1;
	await nextTick();
	if (!imageEl.value) return;
	imageEl.value.src = assetUrl(item.fileId, { rev: item.rev });
	destroyCropper();
	cropper = new Cropper(imageEl.value, {
		viewMode: 1,
		autoCropArea: 1,
		background: true,
		responsive: true,
		checkOrientation: true,
	});
}
function destroyCropper() {
	if (cropper) {
		cropper.destroy();
		cropper = null;
	}
}
function closeImage() {
	if (imageSaving.value) return;
	destroyCropper();
	imageActive.value = false;
	imageItem.value = null;
}
function rotate(deg: number) {
	cropper?.rotate(deg);
}
function flipH() {
	flipX = -flipX;
	cropper?.scaleX(flipX);
}
function flipV() {
	flipY = -flipY;
	cropper?.scaleY(flipY);
}
function resetImage() {
	flipX = 1;
	flipY = 1;
	cropper?.reset();
}
function canvasMime(item: GalleryItem) {
	const t = item.file.type || '';
	if (t === 'image/png' || t === 'image/webp' || t === 'image/jpeg') return t;
	return 'image/jpeg';
}
async function saveImage() {
	if (!cropper || !imageItem.value) return;
	const item = imageItem.value;
	const mime = canvasMime(item);
	imageSaving.value = true;
	try {
		const canvas = cropper.getCroppedCanvas({ imageSmoothingQuality: 'high' });
		const blob: Blob | null = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, 0.92));
		if (!blob) throw new Error('Could not export image');
		const filename = item.file.filename_download || `image.${mime.split('/')[1]}`;
		const form = new FormData();
		form.append('file', new File([blob], filename, { type: mime }));
		const res = await api.patch(`/files/${item.fileId}`, form, {
			params: { fields: ['id', 'title', 'type', 'filename_download', 'width', 'height', 'filesize'] },
		});
		patchLocalFile(item.key, res.data?.data ?? {}, true);
		notify('Image saved');
		destroyCropper();
		imageActive.value = false;
		imageItem.value = null;
	} catch (err) {
		notify('Could not save the edited image', 'error');
		// eslint-disable-next-line no-console
		console.error('[photo-gallery] image save failed', err);
	} finally {
		imageSaving.value = false;
	}
}

/* ----------------------------- Upload ------------------------------- */

const fileInput = ref<HTMLInputElement | null>(null);
function pickFiles() {
	if (props.disabled) return;
	fileInput.value?.click();
}
async function onFilesPicked(e: Event) {
	const input = e.target as HTMLInputElement;
	if (input.files && input.files.length) await uploadFiles(Array.from(input.files));
	input.value = '';
}
async function uploadFiles(files: File[]) {
	uploading.value = true;
	uploadProgress.value = 0;
	let done = 0;
	try {
		for (const file of files) {
			const form = new FormData();
			if (props.folder) form.append('folder', props.folder);
			form.append('file', file);
			const res = await api.post('/files', form, {
				onUploadProgress: (evt: any) => {
					if (evt.total) uploadProgress.value = Math.round(((done + evt.loaded / evt.total) / files.length) * 100);
				},
			});
			if (res.data?.data) await linkFile(res.data.data as DirectusFile);
			done++;
			uploadProgress.value = Math.round((done / files.length) * 100);
		}
		notify(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`);
	} catch (err) {
		notify('Upload failed', 'error');
		// eslint-disable-next-line no-console
		console.error('[photo-gallery] upload failed', err);
	} finally {
		uploading.value = false;
	}
}

const dragOver = ref(false);
function onDrop(e: DragEvent) {
	dragOver.value = false;
	if (props.disabled) return;
	const files = e.dataTransfer?.files;
	if (files && files.length) uploadFiles(Array.from(files));
}

/* --------------------------- Asset URLs ----------------------------- */

function authToken() {
	const auth = (api.defaults.headers?.common?.Authorization ?? api.defaults.headers?.Authorization) as string | undefined;
	return typeof auth === 'string' ? auth.split(' ')[1] : null;
}
function assetUrl(fileId: string, opts: { thumb?: boolean; rev?: number } = {}) {
	const base = (api.defaults.baseURL || '').replace(/\/$/, '');
	const params: string[] = [];
	if (opts.thumb) {
		params.push('width=500', 'height=500', 'quality=80', `fit=${props.thumbnailFit === 'contain' ? 'contain' : 'cover'}`);
	}
	if (opts.rev) params.push(`v=${opts.rev}`);
	const token = authToken();
	if (token) params.push(`access_token=${encodeURIComponent(token)}`);
	return `${base}/assets/${fileId}${params.length ? `?${params.join('&')}` : ''}`;
}
function isImage(file: DirectusFile) {
	return !!file.type && file.type.startsWith('image/');
}
function iconFor(file: DirectusFile) {
	const t = file.type || '';
	if (t.startsWith('video/')) return 'movie';
	if (t.startsWith('audio/')) return 'audiotrack';
	if (t.includes('pdf')) return 'picture_as_pdf';
	if (t.startsWith('image/')) return 'image';
	return 'insert_drive_file';
}
function displayName(file: DirectusFile) {
	return file.title || file.filename_download || file.id;
}
function fileSubtitle(file: DirectusFile) {
	const parts: string[] = [];
	const ext = extLabel(file);
	if (ext) parts.push(ext);
	const size = formatBytes(file.filesize);
	if (size) parts.push(size);
	return parts.join(' • ');
}
function extLabel(file: DirectusFile) {
	const name = file.filename_download || '';
	const dot = name.lastIndexOf('.');
	if (dot > -1 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
	if (file.type) {
		const sub = file.type.split('/')[1];
		if (sub) return sub.split('+')[0].toUpperCase();
	}
	return '';
}
function formatBytes(size: number | string | null | undefined) {
	if (size == null) return '';
	const bytes = typeof size === 'string' ? parseInt(size, 10) : size;
	if (!bytes || isNaN(bytes)) return '';
	const units = ['B', 'kB', 'MB', 'GB', 'TB'];
	let i = 0;
	let n = bytes;
	while (n >= 1024 && i < units.length - 1) {
		n /= 1024;
		i++;
	}
	return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/* ---------------------------- Sortable ------------------------------ */

const gridRef = ref<HTMLElement | null>(null);
let sortable: Sortable | null = null;

function destroySortable() {
	if (sortable) {
		sortable.destroy();
		sortable = null;
	}
}
async function ensureSortable() {
	await nextTick();
	if (!dialogActive.value || props.disabled || items.value.length === 0) {
		destroySortable();
		return;
	}
	if (!gridRef.value || sortable) return;
	sortable = Sortable.create(gridRef.value, {
		animation: 180,
		easing: 'cubic-bezier(0.2, 0, 0, 1)',
		draggable: '.gallery-card',
		filter: '.no-drag',
		preventOnFilter: false,
		forceFallback: true,
		fallbackClass: 'gallery-fallback',
		ghostClass: 'gallery-ghost',
		chosenClass: 'gallery-chosen',
		dragClass: 'gallery-drag',
		onEnd(evt) {
			const oldIndex = evt.oldIndex ?? 0;
			const newIndex = evt.newIndex ?? 0;
			const from = evt.from;
			const node = evt.item;
			if (node.parentNode) node.parentNode.removeChild(node);
			const ref = from.children[oldIndex] ?? null;
			from.insertBefore(node, ref);
			if (oldIndex !== newIndex) moveInArray(oldIndex, newIndex);
		},
	});
}
watch([dialogActive, () => items.value.length, () => props.disabled], ensureSortable);

/* ---------------------------- Lifecycle ----------------------------- */

watch(
	() => [props.primaryKey, props.collection, props.field, relationInfo.value] as const,
	() => {
		if (relationInfo.value && loadedFor.value !== props.primaryKey) loadExisting();
	},
	{ immediate: true }
);

function openDialog() {
	dialogActive.value = true;
	ensureSortable();
}
function closeDialog() {
	if (busy.value) return;
	if (menuOpen.value) return closeMenu();
	if (imageActive.value) return closeImage();
	if (infoActive.value) return closeInfo();
	if (confirmActive.value) {
		confirmActive.value = false;
		return;
	}
	dialogActive.value = false;
	selected.value = new Set();
	destroySortable();
}
function notify(title: string, type: 'success' | 'error' = 'success') {
	statusMsg.value = title;
	statusType.value = type;
	if (statusTimer) clearTimeout(statusTimer);
	statusTimer = setTimeout(() => {
		statusMsg.value = '';
	}, type === 'error' ? 4000 : 2600);
}
onBeforeUnmount(() => {
	destroySortable();
	destroyCropper();
	if (statusTimer) clearTimeout(statusTimer);
});
</script>

<template>
	<div class="photo-gallery">
		<!-- Collapsed summary -->
		<button type="button" class="summary" :class="{ disabled }" @click="openDialog">
			<span class="summary-icon"><v-icon name="photo_library" /></span>
			<span class="summary-text">
				<span class="summary-label">Photo gallery</span>
				<span class="summary-sub">
					<template v-if="loading">Loading…</template>
					<template v-else>{{ count }} {{ count === 1 ? 'photo' : 'photos' }}</template>
				</span>
			</span>
			<v-icon class="summary-chevron" name="open_in_full" small />
		</button>

		<!-- Fullscreen overlay -->
		<teleport to="body">
			<transition name="pg-fade">
				<div v-if="dialogActive" class="pg-overlay" tabindex="-1" @keydown.esc="closeDialog">
					<header class="pg-header">
						<div class="pg-title">
							<v-icon name="photo_library" small />
							<h2>Photo Gallery</h2>
							<span class="pg-count">{{ count }} {{ count === 1 ? 'Item' : 'Items' }}</span>
						</div>

						<div class="pg-status-wrap">
							<transition name="pg-fade">
								<div v-if="statusMsg" class="pg-status" :class="statusType">
									<v-icon :name="statusType === 'error' ? 'error' : 'check_circle'" small />
									{{ statusMsg }}
								</div>
							</transition>
						</div>

						<div class="pg-header-actions">
							<template v-if="someSelected">
								<button class="pg-icon-btn" title="Download" aria-label="Download selected" @click="downloadFiles(selectedItems)">
									<v-icon name="download" small />
								</button>
								<button
									v-if="!disabled"
									class="pg-icon-btn danger"
									title="Delete"
									aria-label="Delete selected files"
									:disabled="deleting"
									@click="requestDelete(selectedItems)"
								>
									<v-icon name="delete" small />
								</button>
								<span class="pg-divider" />
							</template>

							<button v-if="!disabled" class="pg-btn pg-btn-primary pg-btn-sm" :disabled="busy" @click="pickFiles">
								<v-icon name="upload" small /> Upload
							</button>
							<button
								class="pg-icon-btn"
								:class="{ 'is-disabled': busy }"
								:disabled="busy"
								:title="busy ? 'Please wait…' : 'Close'"
								aria-label="Close"
								@click="closeDialog"
							>
								<v-icon name="close" small />
							</button>
						</div>
					</header>

					<div v-if="uploading" class="pg-progress"><div class="pg-progress-bar" :style="{ width: uploadProgress + '%' }" /></div>

					<div v-if="count > 0" class="pg-toolbar">
						<div class="pg-toolbar-left">
							<template v-if="someSelected">
								<button class="pg-clear" title="Clear selection" aria-label="Clear selection" @click="clearSelection">
									<v-icon name="cancel" small />
								</button>
								<span class="pg-selcount">{{ selected.size }} {{ selected.size === 1 ? 'Item' : 'Items' }} Selected</span>
							</template>
							<label v-else class="pg-selectall">
								<input type="checkbox" :checked="allSelected" @change="toggleSelectAll" />
								<v-icon :name="allSelected ? 'check_box' : 'check_box_outline_blank'" small />
								Select All
							</label>
						</div>

						<div class="pg-toolbar-right">
							<span v-if="!hasSortField" class="pg-warn" title="Add a sort field to persist order">
								<v-icon name="warning" small /> Order won't save
							</span>
							<span v-else class="pg-hint"><v-icon name="drag_indicator" small /> Drag to reorder</span>

							<div class="pg-sizes" role="group" aria-label="Tile size">
								<button
									v-for="s in ['s', 'm', 'l', 'xl']"
									:key="s"
									class="pg-size-btn"
									:class="{ on: tileSize === s }"
									:title="`Tile size: ${s.toUpperCase()}`"
									@click="setTileSize(s)"
								>
									<span class="pg-size-dot" :class="`sz-${s}`" />
								</button>
							</div>
						</div>
					</div>

					<div
						class="pg-body"
						:class="{ 'drag-over': dragOver }"
						@dragover.prevent="dragOver = true"
						@dragleave.prevent="dragOver = false"
						@drop.prevent="onDrop"
					>
						<div v-if="count === 0" class="pg-empty">
							<div class="pg-dropzone" :class="{ over: dragOver }">
								<button class="pg-drop-btn" :disabled="disabled" @click="pickFiles" title="Upload files">
									<v-icon name="upload" large />
								</button>
								<p class="pg-drop-text">Drag &amp; Drop files here</p>
								<p class="pg-drop-sub">or click to upload photos to the gallery</p>
							</div>
						</div>

						<div v-else ref="gridRef" class="pg-grid" :style="{ '--pg-tile-min': tileMin + 'px' }">
							<div
								v-for="item in items"
								:key="item.key"
								class="gallery-card"
								:class="{
									selected: selected.has(item.key),
									draggable: hasSortField && !disabled,
									'menu-open': menuOpen && menuItem && menuItem.key === item.key,
								}"
							>
								<div class="card-media">
									<img
										v-if="isImage(item.file)"
										:src="assetUrl(item.fileId, { thumb: true, rev: item.rev })"
										:alt="displayName(item.file)"
										loading="lazy"
										draggable="false"
									/>
									<div v-else class="card-fileicon"><v-icon :name="iconFor(item.file)" x-large /></div>

									<button
										class="card-select no-drag"
										:class="{ on: selected.has(item.key) }"
										:aria-label="selected.has(item.key) ? 'Deselect' : 'Select'"
										@click.stop="toggleSelect(item)"
										@pointerdown.stop
									>
										<v-icon :name="selected.has(item.key) ? 'check_circle' : 'radio_button_unchecked'" small />
									</button>

									<button
										class="card-menu no-drag"
										title="Options"
										aria-label="Options"
										@click.stop="openMenu(item, $event)"
										@pointerdown.stop
									>
										<v-icon name="more_vert" small />
									</button>
								</div>

								<div class="card-meta">
									<span class="card-name" :title="displayName(item.file)">{{ displayName(item.file) }}</span>
									<span class="card-sub">{{ fileSubtitle(item.file) }}</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Delete confirmation -->
					<transition name="pg-fade">
						<div v-if="confirmActive" class="pg-confirm-backdrop" @click.self="confirmActive = false">
							<div class="pg-confirm-card">
								<p class="pg-confirm-msg">{{ confirmMessage }}</p>
								<div class="pg-confirm-actions">
									<button class="pg-cancel-btn" @click="confirmActive = false">Cancel</button>
									<button class="pg-delete-btn" @click="performDelete">Delete</button>
								</div>
							</div>
						</div>
					</transition>

					<!-- Edit info side panel -->
					<transition name="pg-fade">
						<div v-if="infoActive" class="pg-drawer-backdrop" @click.self="closeInfo">
							<aside class="pg-drawer">
								<header class="pg-drawer-head">
									<div class="pg-drawer-title">
										<v-icon name="folder" small />
										<span>{{ infoItem ? displayName(infoItem.file) : 'File' }}</span>
									</div>
									<div class="pg-drawer-head-actions">
										<button class="pg-icon-btn" title="Download" :disabled="!infoItem" @click="infoItem && downloadFiles([infoItem])">
											<v-icon name="download" small />
										</button>
										<button class="pg-btn pg-btn-primary pg-btn-sm" :disabled="infoSaving || infoLoading" @click="saveInfo">Save</button>
										<button class="pg-icon-btn" title="Close" :disabled="infoSaving" @click="closeInfo"><v-icon name="close" small /></button>
									</div>
								</header>

								<div v-if="infoLoading" class="pg-drawer-loading"><v-progress-circular indeterminate /></div>

								<div v-else class="pg-drawer-body">
									<div class="pg-preview">
										<img
											v-if="infoItem && infoMeta && isImage(infoMeta)"
											:src="assetUrl(infoItem.fileId, { rev: infoItem.rev })"
											alt="preview"
										/>
										<div v-else class="card-fileicon"><v-icon :name="iconFor(infoMeta || {})" x-large /></div>
									</div>
									<button class="pg-replace-link" :disabled="disabled || infoSaving" @click="pickReplace">Replace File</button>

									<label class="pg-field">
										<span>Title</span>
										<input v-model="infoForm.title" type="text" class="pg-input" :disabled="infoSaving" />
									</label>
									<label class="pg-field">
										<span>Description</span>
										<textarea v-model="infoForm.description" rows="3" class="pg-input" placeholder="An optional description…" :disabled="infoSaving" />
									</label>
									<div class="pg-field">
										<span>Tags</span>
										<div class="pg-tags">
											<span v-for="t in infoForm.tags" :key="t" class="pg-tag">
												{{ t }}
												<button class="pg-tag-x" aria-label="Remove tag" @click="removeInfoTag(t)"><v-icon name="close" x-small /></button>
											</span>
											<input
												v-model="infoNewTag"
												type="text"
												class="pg-tag-input"
												placeholder="Add a tag and press Enter…"
												:disabled="infoSaving"
												@keydown.enter.prevent="addInfoTag"
												@keydown.,.prevent="addInfoTag"
											/>
										</div>
									</div>
									<label class="pg-field">
										<span>Location</span>
										<input v-model="infoForm.location" type="text" class="pg-input" placeholder="An optional location…" :disabled="infoSaving" />
									</label>
									<label class="pg-field">
										<span>Storage</span>
										<input :value="infoMeta?.storage || ''" type="text" class="pg-input" disabled />
									</label>
								</div>
							</aside>
						</div>
					</transition>

					<!-- Edit image editor -->
					<div v-if="imageActive" class="pg-editor">
						<header class="pg-editor-head">
							<div class="pg-editor-title"><v-icon name="crop" /> Editing Image</div>
							<div class="pg-editor-head-actions">
								<button class="pg-btn pg-btn-primary pg-btn-sm" :disabled="imageSaving" @click="saveImage">
									<v-icon v-if="imageSaving" name="progress_activity" small /> Save
								</button>
								<button class="pg-icon-btn" title="Close" :disabled="imageSaving" @click="closeImage"><v-icon name="close" /></button>
							</div>
						</header>
						<div class="pg-editor-stage">
							<img ref="imageEl" class="pg-editor-img" alt="editing" />
						</div>
						<div class="pg-editor-toolbar">
							<button class="pg-tool" title="Rotate left" @click="rotate(-90)"><v-icon name="rotate_left" /></button>
							<button class="pg-tool" title="Rotate right" @click="rotate(90)"><v-icon name="rotate_right" /></button>
							<span class="pg-tool-sep" />
							<button class="pg-tool" title="Flip horizontal" @click="flipH"><v-icon name="flip" /></button>
							<button class="pg-tool" title="Flip vertical" @click="flipV"><v-icon name="flip" style="transform: rotate(90deg)" /></button>
							<span class="pg-tool-sep" />
							<button class="pg-tool" title="Reset" @click="resetImage"><v-icon name="restart_alt" /></button>
						</div>
					</div>

					<input ref="infoReplaceInput" type="file" class="pg-file-input" @change="onReplacePicked" />
				</div>
			</transition>
		</teleport>

		<!-- Context menu -->
		<teleport to="body">
			<div v-if="menuOpen" class="pg-menu-layer" @click="closeMenu" @contextmenu.prevent="closeMenu">
				<div class="pg-menu" :style="{ left: menuPos.x + 'px', top: menuPos.y + 'px' }" @click.stop>
					<button class="pg-menu-item" @click="menuAction('info')"><v-icon name="edit" small /> Edit info</button>
					<button class="pg-menu-item" @click="menuAction('image')"><v-icon name="tune" small /> Edit image</button>
					<button class="pg-menu-item" @click="menuAction('download')"><v-icon name="download" small /> Download</button>
					<div class="pg-menu-sep" />
					<button class="pg-menu-item danger" @click="menuAction('delete')"><v-icon name="delete" small /> Delete</button>
				</div>
			</div>
		</teleport>

		<input ref="fileInput" type="file" multiple class="pg-file-input" @change="onFilesPicked" />
	</div>
</template>

<style scoped>
.photo-gallery,
.pg-overlay,
.pg-menu-layer {
	--pg-primary: var(--theme--primary, var(--primary, #6644ff));
	--pg-bg: var(--theme--background, var(--background-page, #16171c));
	--pg-bg-normal: var(--theme--background-normal, var(--background-normal, #21222c));
	--pg-bg-subdued: var(--theme--background-subdued, var(--background-subdued, #1a1b23));
	--pg-fg: var(--theme--foreground, var(--foreground-normal, #c9cbd1));
	--pg-fg-subdued: var(--theme--foreground-subdued, var(--foreground-subdued, #7c7e8b));
	--pg-border: var(--theme--border-color, var(--border-normal, #2d2f3a));
	--pg-radius: var(--theme--border-radius, var(--border-radius, 8px));
	--pg-danger: var(--theme--danger, var(--danger, #e35169));
}

/* Collapsed summary */
.summary {
	display: flex;
	align-items: center;
	gap: 14px;
	width: 100%;
	padding: 12px 16px;
	background: var(--theme--form--field--input--background, var(--pg-bg-normal));
	border: var(--theme--border-width, 2px) solid var(--pg-border);
	border-radius: var(--pg-radius);
	color: var(--pg-fg);
	cursor: pointer;
	text-align: left;
	transition: border-color 0.15s, background 0.15s;
	font: inherit;
}
.summary:hover:not(.disabled) {
	border-color: var(--pg-primary);
}
.summary.disabled {
	cursor: default;
	opacity: 0.7;
}
.summary-icon {
	display: grid;
	place-items: center;
	width: 44px;
	height: 44px;
	border-radius: var(--pg-radius);
	background: color-mix(in srgb, var(--pg-primary) 16%, transparent);
	color: var(--pg-primary);
}
.summary-text {
	display: flex;
	flex-direction: column;
	flex: 1;
	min-width: 0;
}
.summary-label {
	font-weight: 600;
}
.summary-sub {
	color: var(--pg-fg-subdued);
	font-size: 13px;
}
.summary-chevron {
	color: var(--pg-fg-subdued);
}

/* Overlay */
.pg-overlay {
	position: fixed;
	inset: 0;
	z-index: 600;
	display: flex;
	flex-direction: column;
	background: var(--pg-bg, #16171c);
	color: var(--pg-fg);
}
.pg-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 16px;
	height: 52px;
	padding: 0 12px 0 20px;
	border-bottom: 1px solid var(--pg-border);
}
.pg-title {
	display: flex;
	align-items: center;
	gap: 10px;
	color: var(--pg-fg);
}
.pg-title h2 {
	font-size: 16px;
	font-weight: 700;
	margin: 0;
}
.pg-count {
	color: var(--pg-fg-subdued);
	font-size: 13px;
	font-weight: 500;
}
.pg-header-actions {
	display: flex;
	align-items: center;
	gap: 6px;
}
.pg-status-wrap {
	flex: 1;
	display: flex;
	justify-content: center;
	min-width: 0;
	overflow: hidden;
}
.pg-status {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 5px 12px;
	border-radius: 999px;
	font-size: 13px;
	font-weight: 600;
	white-space: nowrap;
}
.pg-status.success {
	color: var(--theme--success, #2ecda7);
	background: color-mix(in srgb, var(--theme--success, #2ecda7) 16%, transparent);
}
.pg-status.error {
	color: var(--pg-danger);
	background: color-mix(in srgb, var(--pg-danger) 16%, transparent);
}
.pg-divider {
	width: 1px;
	height: 22px;
	background: var(--pg-border);
	margin: 0 2px;
}
.pg-icon-btn {
	display: grid;
	place-items: center;
	width: 34px;
	height: 34px;
	border: none;
	border-radius: var(--pg-radius);
	background: transparent;
	color: var(--pg-fg-subdued);
	cursor: pointer;
	transition: background 0.12s, color 0.12s;
}
.pg-icon-btn:hover:not(:disabled) {
	background: var(--pg-bg-normal);
	color: var(--pg-fg);
}
.pg-icon-btn.danger {
	background: color-mix(in srgb, var(--pg-danger) 18%, transparent);
	color: var(--pg-danger);
}
.pg-icon-btn.danger:hover:not(:disabled) {
	background: color-mix(in srgb, var(--pg-danger) 30%, transparent);
}
.pg-icon-btn:disabled,
.pg-icon-btn.is-disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.pg-btn {
	display: inline-flex;
	align-items: center;
	gap: 6px;
	padding: 8px 14px;
	border: 1px solid var(--pg-border);
	border-radius: var(--pg-radius);
	background: var(--pg-bg-normal);
	color: var(--pg-fg);
	font: inherit;
	font-size: 14px;
	font-weight: 600;
	cursor: pointer;
	white-space: nowrap;
	transition: background 0.15s, border-color 0.15s, color 0.15s, opacity 0.15s;
}
.pg-btn:hover:not(:disabled) {
	border-color: var(--pg-primary);
}
.pg-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}
.pg-btn-sm {
	padding: 6px 12px;
	font-size: 13px;
}
.pg-btn-primary {
	background: var(--pg-primary);
	border-color: var(--pg-primary);
	color: #fff;
}
.pg-btn-primary:hover:not(:disabled) {
	filter: brightness(1.08);
}

.pg-progress {
	height: 3px;
	background: var(--pg-bg-normal);
	overflow: hidden;
}
.pg-progress-bar {
	height: 100%;
	background: var(--pg-primary);
	transition: width 0.2s;
}

.pg-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0 20px;
	height: 48px;
	min-height: 48px;
	border-bottom: 1px solid var(--pg-border);
}
.pg-toolbar-left {
	display: flex;
	align-items: center;
	gap: 8px;
	min-height: 34px;
}
.pg-selectall {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	cursor: pointer;
	font-weight: 600;
	color: var(--pg-fg-subdued);
	user-select: none;
}
.pg-selectall input {
	display: none;
}
.pg-clear {
	display: grid;
	place-items: center;
	width: 28px;
	height: 28px;
	border: none;
	border-radius: 50%;
	background: transparent;
	color: var(--pg-fg-subdued);
	cursor: pointer;
}
.pg-clear:hover {
	background: var(--pg-bg-normal);
	color: var(--pg-fg);
}
.pg-selcount {
	font-weight: 600;
	color: var(--pg-fg);
}
.pg-toolbar-right {
	display: flex;
	align-items: center;
	gap: 16px;
}
.pg-hint,
.pg-warn {
	display: inline-flex;
	align-items: center;
	gap: 5px;
	font-size: 13px;
	color: var(--pg-fg-subdued);
}
.pg-warn {
	color: var(--theme--warning, #ffa439);
}

.pg-sizes {
	display: inline-flex;
	gap: 2px;
	padding: 3px;
	border: 1px solid var(--pg-border);
	border-radius: var(--pg-radius);
	background: var(--pg-bg-normal);
}
.pg-size-btn {
	display: grid;
	place-items: center;
	width: 30px;
	height: 26px;
	border: none;
	border-radius: 5px;
	background: transparent;
	cursor: pointer;
	transition: background 0.12s;
}
.pg-size-btn:hover {
	background: var(--pg-bg-subdued);
}
.pg-size-btn.on {
	background: color-mix(in srgb, var(--pg-primary) 22%, transparent);
}
.pg-size-dot {
	display: block;
	background: var(--pg-fg-subdued);
	border-radius: 2px;
}
.pg-size-btn.on .pg-size-dot {
	background: var(--pg-primary);
}
.sz-s {
	width: 8px;
	height: 8px;
}
.sz-m {
	width: 11px;
	height: 11px;
}
.sz-l {
	width: 14px;
	height: 14px;
}
.sz-xl {
	width: 17px;
	height: 17px;
}

.pg-body {
	flex: 1;
	overflow-y: auto;
	padding: 20px;
	position: relative;
}
.pg-body.drag-over::after {
	content: 'Drop to upload';
	position: absolute;
	inset: 12px;
	border: 2px dashed var(--pg-primary);
	border-radius: var(--pg-radius);
	display: grid;
	place-items: center;
	font-size: 18px;
	font-weight: 700;
	color: var(--pg-primary);
	background: color-mix(in srgb, var(--pg-primary) 8%, transparent);
	pointer-events: none;
}

.pg-empty {
	height: 100%;
	display: grid;
	place-items: center;
}
.pg-dropzone {
	width: min(560px, 90%);
	padding: 48px 32px;
	border: 2px dashed var(--pg-border);
	border-radius: 12px;
	text-align: center;
	transition: border-color 0.15s, background 0.15s;
}
.pg-dropzone.over {
	border-color: var(--pg-primary);
	background: color-mix(in srgb, var(--pg-primary) 6%, transparent);
}
.pg-drop-btn {
	width: 64px;
	height: 64px;
	margin: 0 auto 20px;
	display: grid;
	place-items: center;
	border-radius: var(--pg-radius);
	border: 1px solid var(--pg-border);
	background: var(--pg-bg-normal);
	color: var(--pg-fg);
	cursor: pointer;
	transition: border-color 0.15s, color 0.15s, transform 0.1s;
}
.pg-drop-btn:hover:not(:disabled) {
	border-color: var(--pg-primary);
	color: var(--pg-primary);
	transform: translateY(-2px);
}
.pg-drop-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}
.pg-drop-text {
	font-size: 18px;
	font-weight: 700;
	margin: 0 0 4px;
}
.pg-drop-sub {
	color: var(--pg-fg-subdued);
	margin: 0;
	font-size: 14px;
}

.pg-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(var(--pg-tile-min, 150px), 1fr));
	gap: 16px;
}
.gallery-card {
	background: var(--pg-bg-normal);
	border: 2px solid var(--pg-border);
	border-radius: var(--pg-radius);
	overflow: hidden;
	transition: border-color 0.15s, box-shadow 0.15s;
	user-select: none;
}
.gallery-card.draggable {
	cursor: grab;
}
.gallery-card.draggable:active {
	cursor: grabbing;
}
.gallery-card:hover {
	border-color: var(--pg-primary);
	box-shadow: 0 6px 20px rgba(0, 0, 0, 0.28);
}
.gallery-card.selected {
	border-color: var(--pg-primary);
	box-shadow: 0 0 0 2px var(--pg-primary) inset;
}
.card-media {
	position: relative;
	aspect-ratio: 1 / 1;
	background: var(--pg-bg-subdued);
	overflow: hidden;
}
.card-media img {
	width: 100%;
	height: 100%;
	object-fit: cover;
	display: block;
	pointer-events: none;
}
.card-fileicon {
	width: 100%;
	height: 100%;
	display: grid;
	place-items: center;
	color: var(--pg-fg-subdued);
}
.card-select,
.card-menu {
	position: absolute;
	top: 8px;
	width: 30px;
	height: 30px;
	display: grid;
	place-items: center;
	border: none;
	border-radius: 50%;
	background: rgba(10, 11, 16, 0.6);
	color: #fff;
	cursor: pointer;
	opacity: 0;
	backdrop-filter: blur(3px);
	transition: opacity 0.15s, background 0.15s, transform 0.1s;
}
.card-select {
	left: 8px;
}
.card-menu {
	right: 8px;
}
.gallery-card:hover .card-select,
.gallery-card:hover .card-menu,
.gallery-card.menu-open .card-menu,
.card-select.on {
	opacity: 1;
}
.gallery-card.menu-open .card-menu {
	background: rgba(10, 11, 16, 0.85);
	color: var(--pg-primary);
}
.card-select.on {
	background: var(--pg-primary);
}
.card-select:hover,
.card-menu:hover {
	transform: scale(1.1);
	background: rgba(10, 11, 16, 0.85);
}
.card-meta {
	padding: 10px 12px;
}
.card-name {
	display: block;
	font-size: 13px;
	font-weight: 600;
	color: var(--pg-fg);
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
}
.card-sub {
	display: block;
	margin-top: 2px;
	font-size: 12px;
	color: var(--pg-fg-subdued);
	text-transform: uppercase;
	letter-spacing: 0.02em;
}

/* Sortable states */
.gallery-ghost {
	border: 2px dashed var(--pg-primary) !important;
	background: color-mix(in srgb, var(--pg-primary) 14%, transparent) !important;
	box-shadow: none !important;
}
.gallery-ghost > * {
	visibility: hidden;
}
.gallery-chosen {
	cursor: grabbing;
}
.gallery-drag,
.gallery-fallback {
	opacity: 0.98 !important;
	box-shadow: 0 18px 40px rgba(0, 0, 0, 0.5) !important;
	transform: scale(1.03);
	border-color: var(--pg-primary) !important;
}

/* Confirmation modal */
.pg-confirm-backdrop {
	position: absolute;
	inset: 0;
	z-index: 40;
	background: rgba(0, 0, 0, 0.6);
	display: grid;
	place-items: center;
	padding: 24px;
}
.pg-confirm-card {
	width: min(560px, 100%);
	background: var(--pg-bg-normal);
	border-radius: 12px;
	padding: 28px 28px 20px;
	box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5);
}
.pg-confirm-msg {
	margin: 0 0 24px;
	font-size: 18px;
	font-weight: 700;
	line-height: 1.4;
	color: var(--pg-fg);
}
.pg-confirm-actions {
	display: flex;
	justify-content: flex-end;
	gap: 10px;
}
.pg-cancel-btn,
.pg-delete-btn {
	padding: 10px 20px;
	border: none;
	border-radius: var(--pg-radius);
	font: inherit;
	font-size: 15px;
	font-weight: 600;
	cursor: pointer;
	transition: filter 0.12s, background 0.12s;
}
.pg-cancel-btn {
	background: var(--pg-bg-subdued);
	color: var(--pg-fg);
}
.pg-cancel-btn:hover {
	background: color-mix(in srgb, var(--pg-fg) 12%, var(--pg-bg-subdued));
}
.pg-delete-btn {
	background: var(--pg-danger);
	color: #fff;
}
.pg-delete-btn:hover {
	filter: brightness(1.08);
}

/* Edit info side panel */
.pg-drawer-backdrop {
	position: absolute;
	inset: 0;
	z-index: 30;
	background: rgba(0, 0, 0, 0.5);
	display: flex;
	justify-content: flex-end;
}
.pg-drawer {
	width: min(720px, 100%);
	height: 100%;
	background: var(--pg-bg);
	border-left: 1px solid var(--pg-border);
	display: flex;
	flex-direction: column;
	box-shadow: -20px 0 50px rgba(0, 0, 0, 0.4);
	animation: pg-slide 0.2s ease;
}
@keyframes pg-slide {
	from {
		transform: translateX(40px);
		opacity: 0.5;
	}
}
.pg-drawer-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 56px;
	padding: 0 12px 0 20px;
	border-bottom: 1px solid var(--pg-border);
}
.pg-drawer-title {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 16px;
	font-weight: 700;
	color: var(--pg-fg);
}
.pg-drawer-head-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}
.pg-drawer-loading {
	flex: 1;
	display: grid;
	place-items: center;
}
.pg-drawer-body {
	flex: 1;
	overflow-y: auto;
	padding: 24px;
	max-width: 640px;
	width: 100%;
	margin: 0 auto;
}
.pg-preview {
	width: 100%;
	max-height: 60vh;
	min-height: 240px;
	display: grid;
	place-items: center;
	border-radius: var(--pg-radius);
	overflow: hidden;
	background: var(--pg-bg-subdued);
	border: 1px solid var(--pg-border);
}
.pg-preview img {
	max-width: 100%;
	max-height: 60vh;
	object-fit: contain;
	display: block;
}
.pg-replace-link {
	display: inline-block;
	margin: 12px 0 24px;
	padding: 0;
	border: none;
	background: transparent;
	color: var(--pg-primary);
	font: inherit;
	font-weight: 700;
	cursor: pointer;
}
.pg-replace-link:disabled {
	opacity: 0.5;
	cursor: not-allowed;
}
.pg-field {
	display: block;
	margin-bottom: 20px;
}
.pg-field > span {
	display: block;
	margin-bottom: 8px;
	font-size: 15px;
	font-weight: 700;
	color: var(--pg-fg);
}
.pg-input {
	width: 100%;
	padding: 12px 14px;
	border: 1px solid var(--pg-border);
	border-radius: var(--pg-radius);
	background: var(--pg-bg-subdued);
	color: var(--pg-fg);
	font: inherit;
	resize: vertical;
}
.pg-input:focus {
	outline: none;
	border-color: var(--pg-primary);
}
.pg-input:disabled {
	opacity: 0.7;
}
.pg-tags {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	padding: 8px;
	border: 1px solid var(--pg-border);
	border-radius: var(--pg-radius);
	background: var(--pg-bg-subdued);
}
.pg-tag {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	padding: 4px 6px 4px 12px;
	border-radius: 999px;
	background: color-mix(in srgb, var(--pg-primary) 20%, transparent);
	color: var(--pg-fg);
	font-size: 13px;
}
.pg-tag-x {
	display: grid;
	place-items: center;
	border: none;
	background: transparent;
	color: inherit;
	cursor: pointer;
	padding: 0;
}
.pg-tag-input {
	flex: 1;
	min-width: 120px;
	border: none;
	background: transparent;
	color: var(--pg-fg);
	font: inherit;
	outline: none;
	padding: 4px;
}

/* Edit image editor */
.pg-editor {
	position: absolute;
	inset: 0;
	z-index: 35;
	display: flex;
	flex-direction: column;
	background: var(--pg-bg);
}
.pg-editor-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	height: 52px;
	padding: 0 12px 0 20px;
	border-bottom: 1px solid var(--pg-border);
	background: var(--pg-bg-subdued);
}
.pg-editor-title {
	display: flex;
	align-items: center;
	gap: 10px;
	font-size: 16px;
	font-weight: 700;
	color: var(--pg-fg);
}
.pg-editor-head-actions {
	display: flex;
	align-items: center;
	gap: 8px;
}
.pg-editor-stage {
	flex: 1;
	min-height: 0;
	padding: 20px;
	display: flex;
	overflow: hidden;
}
.pg-editor-img {
	max-width: 100%;
	max-height: 100%;
	display: block;
	margin: auto;
}
.pg-editor-toolbar {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 6px;
	height: 60px;
	border-top: 1px solid var(--pg-border);
	background: var(--pg-bg-subdued);
}
.pg-tool {
	display: grid;
	place-items: center;
	width: 40px;
	height: 40px;
	border: none;
	border-radius: var(--pg-radius);
	background: var(--pg-bg-normal);
	color: var(--pg-fg);
	cursor: pointer;
	transition: background 0.12s, color 0.12s;
}
.pg-tool:hover {
	background: var(--pg-primary);
	color: #fff;
}
.pg-tool-sep {
	width: 1px;
	height: 24px;
	background: var(--pg-border);
	margin: 0 4px;
}

/* Context menu */
.pg-menu-layer {
	position: fixed;
	inset: 0;
	z-index: 700;
}
.pg-menu {
	position: fixed;
	width: 210px;
	padding: 6px;
	background: var(--pg-bg-normal);
	border: 1px solid var(--pg-border);
	border-radius: 10px;
	box-shadow: 0 16px 40px rgba(0, 0, 0, 0.45);
}
.pg-menu-item {
	display: flex;
	align-items: center;
	gap: 10px;
	width: 100%;
	padding: 9px 12px;
	border: none;
	border-radius: 6px;
	background: transparent;
	color: var(--pg-fg);
	font: inherit;
	font-size: 14px;
	font-weight: 500;
	text-align: left;
	cursor: pointer;
	transition: background 0.12s, color 0.12s;
}
.pg-menu-item:hover {
	background: var(--pg-bg-subdued);
}
.pg-menu-item.danger {
	color: var(--pg-danger);
}
.pg-menu-item.danger:hover {
	background: color-mix(in srgb, var(--pg-danger) 16%, transparent);
}
.pg-menu-sep {
	height: 1px;
	background: var(--pg-border);
	margin: 6px 4px;
}

.pg-file-input {
	display: none;
}

.pg-fade-enter-active,
.pg-fade-leave-active {
	transition: opacity 0.18s ease;
}
.pg-fade-enter-from,
.pg-fade-leave-to {
	opacity: 0;
}
</style>

<style>
/*!
 * Cropper.js v1.6.2
 * https://fengyuanchen.github.io/cropperjs
 *
 * Copyright 2015-present Chen Fengyuan
 * Released under the MIT license
 *
 * Date: 2024-04-21T07:43:02.731Z
 */

.cropper-container {
  direction: ltr;
  font-size: 0;
  line-height: 0;
  position: relative;
  -ms-touch-action: none;
      touch-action: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
     -moz-user-select: none;
      -ms-user-select: none;
          user-select: none;
}

.cropper-container img {
    backface-visibility: hidden;
    display: block;
    height: 100%;
    image-orientation: 0deg;
    max-height: none !important;
    max-width: none !important;
    min-height: 0 !important;
    min-width: 0 !important;
    width: 100%;
  }

.cropper-wrap-box,
.cropper-canvas,
.cropper-drag-box,
.cropper-crop-box,
.cropper-modal {
  bottom: 0;
  left: 0;
  position: absolute;
  right: 0;
  top: 0;
}

.cropper-wrap-box,
.cropper-canvas {
  overflow: hidden;
}

.cropper-drag-box {
  background-color: #fff;
  opacity: 0;
}

.cropper-modal {
  background-color: #000;
  opacity: 0.5;
}

.cropper-view-box {
  display: block;
  height: 100%;
  outline: 1px solid #39f;
  outline-color: rgba(51, 153, 255, 0.75);
  overflow: hidden;
  width: 100%;
}

.cropper-dashed {
  border: 0 dashed #eee;
  display: block;
  opacity: 0.5;
  position: absolute;
}

.cropper-dashed.dashed-h {
    border-bottom-width: 1px;
    border-top-width: 1px;
    height: calc(100% / 3);
    left: 0;
    top: calc(100% / 3);
    width: 100%;
  }

.cropper-dashed.dashed-v {
    border-left-width: 1px;
    border-right-width: 1px;
    height: 100%;
    left: calc(100% / 3);
    top: 0;
    width: calc(100% / 3);
  }

.cropper-center {
  display: block;
  height: 0;
  left: 50%;
  opacity: 0.75;
  position: absolute;
  top: 50%;
  width: 0;
}

.cropper-center::before,
  .cropper-center::after {
    background-color: #eee;
    content: ' ';
    display: block;
    position: absolute;
  }

.cropper-center::before {
    height: 1px;
    left: -3px;
    top: 0;
    width: 7px;
  }

.cropper-center::after {
    height: 7px;
    left: 0;
    top: -3px;
    width: 1px;
  }

.cropper-face,
.cropper-line,
.cropper-point {
  display: block;
  height: 100%;
  opacity: 0.1;
  position: absolute;
  width: 100%;
}

.cropper-face {
  background-color: #fff;
  left: 0;
  top: 0;
}

.cropper-line {
  background-color: #39f;
}

.cropper-line.line-e {
    cursor: ew-resize;
    right: -3px;
    top: 0;
    width: 5px;
  }

.cropper-line.line-n {
    cursor: ns-resize;
    height: 5px;
    left: 0;
    top: -3px;
  }

.cropper-line.line-w {
    cursor: ew-resize;
    left: -3px;
    top: 0;
    width: 5px;
  }

.cropper-line.line-s {
    bottom: -3px;
    cursor: ns-resize;
    height: 5px;
    left: 0;
  }

.cropper-point {
  background-color: #39f;
  height: 5px;
  opacity: 0.75;
  width: 5px;
}

.cropper-point.point-e {
    cursor: ew-resize;
    margin-top: -3px;
    right: -3px;
    top: 50%;
  }

.cropper-point.point-n {
    cursor: ns-resize;
    left: 50%;
    margin-left: -3px;
    top: -3px;
  }

.cropper-point.point-w {
    cursor: ew-resize;
    left: -3px;
    margin-top: -3px;
    top: 50%;
  }

.cropper-point.point-s {
    bottom: -3px;
    cursor: s-resize;
    left: 50%;
    margin-left: -3px;
  }

.cropper-point.point-ne {
    cursor: nesw-resize;
    right: -3px;
    top: -3px;
  }

.cropper-point.point-nw {
    cursor: nwse-resize;
    left: -3px;
    top: -3px;
  }

.cropper-point.point-sw {
    bottom: -3px;
    cursor: nesw-resize;
    left: -3px;
  }

.cropper-point.point-se {
    bottom: -3px;
    cursor: nwse-resize;
    height: 20px;
    opacity: 1;
    right: -3px;
    width: 20px;
  }

@media (min-width: 768px) {

.cropper-point.point-se {
      height: 15px;
      width: 15px;
  }
    }

@media (min-width: 992px) {

.cropper-point.point-se {
      height: 10px;
      width: 10px;
  }
    }

@media (min-width: 1200px) {

.cropper-point.point-se {
      height: 5px;
      opacity: 0.75;
      width: 5px;
  }
    }

.cropper-point.point-se::before {
    background-color: #39f;
    bottom: -50%;
    content: ' ';
    display: block;
    height: 200%;
    opacity: 0;
    position: absolute;
    right: -50%;
    width: 200%;
  }

.cropper-invisible {
  opacity: 0;
}

.cropper-bg {
  background-image: url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQAQMAAAAlPW0iAAAAA3NCSVQICAjb4U/gAAAABlBMVEXMzMz////TjRV2AAAACXBIWXMAAArrAAAK6wGCiw1aAAAAHHRFWHRTb2Z0d2FyZQBBZG9iZSBGaXJld29ya3MgQ1M26LyyjAAAABFJREFUCJlj+M/AgBVhF/0PAH6/D/HkDxOGAAAAAElFTkSuQmCC');
}

.cropper-hide {
  display: block;
  height: 0;
  position: absolute;
  width: 0;
}

.cropper-hidden {
  display: none !important;
}

.cropper-move {
  cursor: move;
}

.cropper-crop {
  cursor: crosshair;
}

.cropper-disabled .cropper-drag-box,
.cropper-disabled .cropper-face,
.cropper-disabled .cropper-line,
.cropper-disabled .cropper-point {
  cursor: not-allowed;
}

</style>
