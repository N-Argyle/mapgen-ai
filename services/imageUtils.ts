
import { MapLayer, Rect } from "../types";

/**
 * Processes an image to remove a solid magenta background.
 * Used for isolated generation.
 */
export const removeMagentaBackground = (imageSrc: string): Promise<string> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "Anonymous";
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject('Could not get canvas context');
          return;
        }
  
        ctx.drawImage(img, 0, 0);
        
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        
        // Target Magenta: R=255, G=0, B=255
        // We use a distance threshold to catch anti-aliased edges
        const targetR = 255;
        const targetG = 0;
        const targetB = 255;
        const threshold = 100; // Sum of abs differences
        
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          
          const dist = Math.abs(r - targetR) + Math.abs(g - targetG) + Math.abs(b - targetB);
          
          if (dist < threshold) {
             data[i + 3] = 0;
          }
        }
        
        ctx.putImageData(imageData, 0, 0);
        resolve(canvas.toDataURL());
      };
      
      img.onerror = (e) => reject(e);
      img.src = imageSrc;
    });
};

/**
 * Composites all visible layers into a single image.
 * Dynamically resizes to fit all layers if no dimensions provided.
 */
export const compositeLayers = (width: number, height: number, layers: MapLayer[]): Promise<string> => {
    return new Promise((resolve) => {
        // Calculate bounds of all visible layers
        const visibleLayers = layers.filter(l => l.visible);
        if (visibleLayers.length === 0) {
            // Fallback to default viewport
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            resolve(canvas.toDataURL());
            return;
        }

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        visibleLayers.forEach(l => {
            minX = Math.min(minX, l.x);
            minY = Math.min(minY, l.y);
            maxX = Math.max(maxX, l.x + l.width);
            maxY = Math.max(maxY, l.y + l.height);
        });

        // If specific width/height requested (e.g. for context generation), use that relative to 0,0
        // Otherwise (for export), use the full bounds
        const exportWidth = width || (maxX - minX);
        const exportHeight = height || (maxY - minY);
        const offsetX = width ? 0 : minX;
        const offsetY = height ? 0 : minY;

        const canvas = document.createElement('canvas');
        canvas.width = exportWidth;
        canvas.height = exportHeight;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(''); return; }

        // Sort by zIndex
        const sorted = [...visibleLayers].sort((a, b) => a.zIndex - b.zIndex);

        let loadedCount = 0;
        const total = sorted.length;

        const checkDone = () => {
            loadedCount++;
            if (loadedCount === total) resolve(canvas.toDataURL());
        };

        sorted.forEach(layer => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                ctx.drawImage(img, layer.x - offsetX, layer.y - offsetY, layer.width, layer.height);
                checkDone();
            };
            img.onerror = checkDone;
            img.src = layer.imageData;
        });
    });
};

/**
 * Captures a specific rectangular region of the current map state.
 * Used to grab edges for seamless generation.
 */
export const getCompositeRect = (rect: Rect, layers: MapLayer[]): Promise<string> => {
    return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = rect.width;
        canvas.height = rect.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve('');

        // Fill background to avoid transparent edges in context
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, rect.width, rect.height);

        const sorted = [...layers].sort((a, b) => a.zIndex - b.zIndex);
        const visible = sorted.filter(l => l.visible);
        
        if (visible.length === 0) return resolve(canvas.toDataURL());

        let loadedCount = 0;
        const checkDone = () => {
            loadedCount++;
            if (loadedCount === visible.length) resolve(canvas.toDataURL());
        };

        visible.forEach(layer => {
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                // Calculate intersection of layer and requested rect
                // We draw the whole layer offset by -rect.x, -rect.y
                // Canvas clipping handles the rest
                ctx.drawImage(img, layer.x - rect.x, layer.y - rect.y, layer.width, layer.height);
                checkDone();
            };
            img.onerror = checkDone;
            img.src = layer.imageData;
        });
    });
};

/**
 * Overlays one image on top of another.
 * Used to add the brush mask to the context sent to AI.
 */
export const overlayImage = (baseSrc: string, overlaySrc: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const imgBase = new Image();
        const imgOverlay = new Image();
        let loaded = 0;

        const onload = () => {
            loaded++;
            if (loaded < 2) return;
            
            const canvas = document.createElement('canvas');
            canvas.width = imgBase.width;
            canvas.height = imgBase.height;
            const ctx = canvas.getContext('2d');
            
            if (ctx) {
                ctx.drawImage(imgBase, 0, 0);
                ctx.drawImage(imgOverlay, 0, 0);
                resolve(canvas.toDataURL());
            } else {
                reject("Failed to create canvas context");
            }
        };

        imgBase.onerror = reject;
        imgOverlay.onerror = reject;

        imgBase.onload = onload;
        imgOverlay.onload = onload;

        imgBase.src = baseSrc;
        imgOverlay.src = overlaySrc;
    });
};

/**
 * Crops a specific region from a base64 image.
 */
export const cropAndResize = (base64Image: string, x: number, y: number, w: number, h: number, targetW: number, targetH: number): Promise<string> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = targetW;
            canvas.height = targetH;
            const ctx = canvas.getContext('2d');
            if(!ctx) return reject("No ctx");

            // Draw the slice of the original image onto the new canvas, scaling it to target size
            ctx.drawImage(img, x, y, w, h, 0, 0, targetW, targetH);
            resolve(canvas.toDataURL());
        };
        img.onerror = reject;
        img.src = base64Image;
    });
};

/**
 * Compares an original context image with a newly generated version.
 * Returns a new image containing ONLY the differences (the new object + shadows).
 */
export const createDifferenceLayer = (originalBase64: string, generatedBase64: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        const imgOrig = new Image();
        const imgGen = new Image();
        
        let loaded = 0;
        const onLoaded = () => {
            loaded++;
            if (loaded < 2) return;

            const width = imgGen.width;
            const height = imgGen.height;

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if(!ctx) return reject("No ctx");

            // 1. Draw Original to get data
            const cOrig = document.createElement('canvas');
            cOrig.width = width;
            cOrig.height = height;
            const ctxOrig = cOrig.getContext('2d');
            if(!ctxOrig) return;
            // Draw original scaled to match generated (in case of slight resolution drift, though we try to keep 1:1)
            ctxOrig.drawImage(imgOrig, 0, 0, width, height);
            const dataOrig = ctxOrig.getImageData(0, 0, width, height).data;

            // 2. Draw Generated to get data
            ctx.drawImage(imgGen, 0, 0);
            const imageDataGen = ctx.getImageData(0, 0, width, height);
            const dataGen = imageDataGen.data;

            // 3. Compare
            const threshold = 35; // Slightly higher threshold to avoid noise

            for (let i = 0; i < dataGen.length; i += 4) {
                const r1 = dataOrig[i];
                const g1 = dataOrig[i+1];
                const b1 = dataOrig[i+2];

                const r2 = dataGen[i];
                const g2 = dataGen[i+1];
                const b2 = dataGen[i+2];

                const dist = Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2);

                if (dist < threshold) {
                    // Pixel is effectively unchanged -> Transparent
                    dataGen[i+3] = 0;
                } else {
                    // Pixel changed -> Opaque (Keep the new pixel)
                    dataGen[i+3] = 255;
                }
            }

            ctx.putImageData(imageDataGen, 0, 0);
            resolve(canvas.toDataURL());
        };

        imgOrig.onload = onLoaded;
        imgGen.onload = onLoaded;
        imgOrig.src = originalBase64;
        imgGen.src = generatedBase64;
    });
};

/**
 * Scans an image (usually a mask) to find the bounding box of non-transparent pixels.
 */
export const getContentBounds = (imageSrc: string, canvasW: number, canvasH: number): Promise<Rect | null> => {
    return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
             const canvas = document.createElement('canvas');
             canvas.width = canvasW;
             canvas.height = canvasH;
             const ctx = canvas.getContext('2d');
             if (!ctx) return resolve(null);
             
             ctx.drawImage(img, 0, 0);
             const imageData = ctx.getImageData(0, 0, canvasW, canvasH);
             const data = imageData.data;
             
             let minX = canvasW;
             let minY = canvasH;
             let maxX = 0;
             let maxY = 0;
             let found = false;
             
             for (let y = 0; y < canvasH; y++) {
                 for (let x = 0; x < canvasW; x++) {
                     const i = (y * canvasW + x) * 4;
                     const alpha = data[i+3];
                     if (alpha > 0) {
                         if (x < minX) minX = x;
                         if (x > maxX) maxX = x;
                         if (y < minY) minY = y;
                         if (y > maxY) maxY = y;
                         found = true;
                     }
                 }
             }
             
             if (!found) resolve(null);
             else resolve({
                 x: minX,
                 y: minY,
                 width: maxX - minX,
                 height: maxY - minY
             });
        };
        img.src = imageSrc;
    });
}
