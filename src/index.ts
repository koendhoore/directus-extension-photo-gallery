import { defineInterface } from '@directus/extensions-sdk';
import PhotoGallery from './interface.vue';

export default defineInterface({
	id: 'photo-gallery',
	name: 'Photo Gallery',
	icon: 'photo_library',
	description: 'A fullscreen, drag-and-drop sortable gallery of files.',
	component: PhotoGallery,
	// An alias field (no real DB column) backed by a Files (M2M) relation.
	types: ['alias'],
	localTypes: ['files'],
	group: 'relational',
	relational: true,
	options: [
		{
			field: 'folder',
			name: 'Upload Folder',
			type: 'uuid',
			meta: {
				interface: 'system-folder',
				width: 'full',
				note: 'Directus folder that newly uploaded / imported files are placed into.',
			},
		},
		{
			field: 'thumbnailFit',
			name: 'Thumbnail Fit',
			type: 'string',
			schema: { default_value: 'cover' },
			meta: {
				interface: 'select-dropdown',
				width: 'half',
				options: {
					choices: [
						{ text: 'Cover (crop to fill)', value: 'cover' },
						{ text: 'Contain (letterbox)', value: 'contain' },
					],
				},
			},
		},
	],
});
