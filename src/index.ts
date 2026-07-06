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
			field: 'insertPosition',
			name: 'New Photos Position',
			type: 'string',
			schema: { default_value: 'bottom' },
			meta: {
				interface: 'select-radio',
				width: 'full',
				options: {
					choices: [
						{ text: 'At the end (after existing photos)', value: 'bottom' },
						{ text: 'On top (before existing photos)', value: 'top' },
					],
				},
				note: 'Where newly uploaded photos are placed in the gallery.',
			},
		},
	],
});
