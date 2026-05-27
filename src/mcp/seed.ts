import { seedStore } from "./graphStore.js";

const store = await seedStore();

console.log(`Seeded ${store.pages.length} pages, ${store.links.length} links, and ${store.canvases.length} canvas.`);
