
import { GoogleGenAI } from "@google/genai";
import { MapSettings, DebugLog } from "../types";
import { cropAndResize } from "./imageUtils";

const getClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key not found in environment variables");
  }
  return new GoogleGenAI({ apiKey });
};

// Helper to construct dynamic style instructions based on settings
const getStyleInstruction = (settings: MapSettings) => {
  let projectionNote = `View: Strictly ${settings.projection}.`;
  if (settings.projection.includes("Sidescroller")) {
      projectionNote += " Gravity is downwards. This is a side-view platformer environment.";
  }

  return `
    Style: ${settings.artStyle}.
    ${projectionNote}
    Lighting: Light source from ${settings.sunDirection}. Shadows must correspond to this direction.
    Aesthetic: High quality 2D game art. High contrast, cohesive colors.
  `;
};

export const generateMapAsset = async (
    prompt: string, 
    settings: MapSettings, 
    contextImageBase64?: string,
    onDebug?: (log: DebugLog) => void
): Promise<string> => {
  const ai = getClient();
  const globalStyle = getStyleInstruction(settings);
  
  let finalPrompt = "";
  let parts: any[] = [];
  let debugInputImage = undefined;

  if (contextImageBase64) {
      // Image-to-Image Generation (Context Aware)
      finalPrompt = `
        Act as a professional game artist.
        Task: Add a ${prompt} to the provided terrain image.
        
        Input Context:
        - The input image may contain a semi-transparent colored region (e.g., pink/magenta).
        - If present, this highlighted region marks the target location and approximate shape for the ${prompt}.
        - Use the underlying terrain texture as a guide for perspective and lighting.
        
        Constraints:
        1. PERSPECTIVE: Maintain the exact ${settings.projection} view.
        2. INTEGRATION: The ${prompt} must look like it belongs on this ground. Add realistic contact shadows based on lighting from ${settings.sunDirection}.
        3. BACKGROUND: DO NOT CHANGE the surrounding terrain texture, color, or pattern outside the generated object. The background must remain identical to the original image so we can extract the object via difference keying.
        4. CONTENT: Generate the ${prompt} filling the designated area. It does not need to perfectly match the mask shape if the object's natural shape dictates otherwise, but it should generally conform to it.
        ${globalStyle}
      `;
      
      const base64Data = contextImageBase64.split(',')[1];
      debugInputImage = contextImageBase64;
      
      parts = [
          {
              inlineData: {
                  mimeType: 'image/png',
                  data: base64Data
              }
          },
          { text: finalPrompt }
      ];

  } else {
      // Text-to-Image Generation (Isolated)
      // Changed to Magenta for better chroma keying
      finalPrompt = `
        Generate a single 2D game asset: ${prompt}.
        ${globalStyle}
        Background: PURE MAGENTA (#FF00FF). The object must be completely isolated on a solid magenta background. Do not cast heavy shadows onto the background, only self-shadows.
        Content: Ensure the object has clean edges and is centered.
      `;
      parts = [{ text: finalPrompt }];
  }

  if (onDebug) {
      onDebug({
          timestamp: Date.now(),
          type: 'Asset',
          prompt: finalPrompt,
          inputImage: debugInputImage
      });
  }

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: parts
      },
      config: {
        imageConfig: {
          aspectRatio: "1:1",
        }
      }
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
      }
    }

    throw new Error("No image data found in response");
  } catch (error) {
    console.error("Gemini Generation Error:", error);
    throw error;
  }
};

export const generateBaseTexture = async (
    promptInput: string, 
    settings: MapSettings,
    onDebug?: (log: DebugLog) => void
): Promise<string> => {
    const ai = getClient();
    const globalStyle = getStyleInstruction(settings);
    
    // Base texture must fill the frame (no black background)
    const prompt = `
      Seamless 2D game terrain texture: ${promptInput}.
      ${globalStyle}
      Properties: Seamless, tileable pattern. Fills the entire image edge-to-edge.
      Content: Ground surface only (e.g., grass, dirt, sand, water, stone). No buildings or isolated objects.
    `;

    if (onDebug) {
        onDebug({
            timestamp: Date.now(),
            type: 'Base',
            prompt: prompt
        });
    }
    
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: { parts: [{ text: prompt }] },
            config: { imageConfig: { aspectRatio: "1:1" } }
        });

        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
              return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
            }
        }
        throw new Error("No base texture generated");
    } catch (error) {
        console.error("Base Texture Generation Error", error);
        throw error;
    }
}

/**
 * Generates a seamless extension of the map by composing neighbor strips.
 */
export const generateSeamlessTexture = async (
    neighbors: { left?: string, right?: string, top?: string, bottom?: string }, 
    settings: MapSettings,
    basePrompt: string = "game terrain",
    onDebug?: (log: DebugLog) => void
): Promise<string> => {
    const ai = getClient();
    const globalStyle = getStyleInstruction(settings);
    
    // Base size is 1024x1024 for the "New Block" (Target)
    const TARGET_SIZE = 1024;
    const STRIP_SIZE = 256;

    let contentW = TARGET_SIZE;
    let contentH = TARGET_SIZE;
    let targetX = 0; 
    let targetY = 0;

    // Calculate content dimensions and target offset
    if (neighbors.left) {
        contentW += STRIP_SIZE;
        targetX += STRIP_SIZE;
    }
    if (neighbors.right) {
        contentW += STRIP_SIZE;
    }
    if (neighbors.top) {
        contentH += STRIP_SIZE;
        targetY += STRIP_SIZE;
    }
    if (neighbors.bottom) {
        contentH += STRIP_SIZE;
    }

    // FORCE SQUARE CANVAS to prevent anamorphic distortion by Gemini
    const canvasSize = Math.max(contentW, contentH);
    
    const canvas = document.createElement('canvas');
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Canvas context failed");
    
    // 1. Fill background with neutral dark color
    ctx.fillStyle = '#222222';
    ctx.fillRect(0, 0, canvasSize, canvasSize);
    
    // 2. Draw Neighbors (Constraints)
    const loadAndDraw = async (src: string, x: number, y: number) => {
        const img = new Image();
        img.src = src;
        await new Promise((r) => { img.onload = r; });
        ctx.drawImage(img, x, y);
    }

    const promises = [];
    const activeDirections = [];

    // Left neighbor strip (placed at x=0 relative to content)
    if (neighbors.left) {
        promises.push(loadAndDraw(neighbors.left, 0, targetY));
        activeDirections.push("LEFT");
    }
    // Right neighbor strip
    if (neighbors.right) {
        promises.push(loadAndDraw(neighbors.right, targetX + TARGET_SIZE, targetY));
        activeDirections.push("RIGHT");
    }
    // Top neighbor strip
    if (neighbors.top) {
        promises.push(loadAndDraw(neighbors.top, targetX, 0));
        activeDirections.push("TOP");
    }
    // Bottom neighbor strip
    if (neighbors.bottom) {
        promises.push(loadAndDraw(neighbors.bottom, targetX, targetY + TARGET_SIZE));
        activeDirections.push("BOTTOM");
    }

    await Promise.all(promises);

    // 2.5 Fill Corners to bridge gaps (optional)
    if (neighbors.top && neighbors.left) {
       // Could average colors here if needed
    }

    // 3. Fill the "Target Void" with PINK to signal the inpainting area
    ctx.fillStyle = '#FF00FF'; // Magenta
    ctx.fillRect(targetX, targetY, TARGET_SIZE, TARGET_SIZE);

    // Redraw strips on top to ensure hard constraints are visible (and cover any overlap)
    await Promise.all(promises);

    const inputImageBase64 = canvas.toDataURL().split(',')[1];
    
    const prompt = `
        Task: Outpaint and fill the PINK (Magenta) square area.
        
        Input Analysis:
        - The image contains "Ground Truth" texture strips on the following sides: ${activeDirections.join(', ')}.
        - The central PINK square is a mask indicating the area to generate.
        
        Instructions:
        1. PRESERVE EDGES: The textures on the ${activeDirections.join(', ')} are strictly fixed. Do not modify them.
        2. FILL MASK: Completely replace the PINK color with new terrain.
        3. SEAMLESS FILL: The new terrain must connect perfectly to the edge strips.
        4. MATCHING: The new terrain must match the exact texture frequency, noise grain, and color palette of the existing strips.
        5. Theme: ${basePrompt}.
        
        Style: ${globalStyle}
    `;

    if (onDebug) {
        onDebug({
            timestamp: Date.now(),
            type: 'Seamless',
            prompt: prompt,
            inputImage: `data:image/png;base64,${inputImageBase64}`
        });
    }

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash-image',
            contents: {
                parts: [
                    { inlineData: { mimeType: 'image/png', data: inputImageBase64 } },
                    { text: prompt }
                ]
            },
            config: { imageConfig: { aspectRatio: "1:1" } }
        });

        let generatedBase64 = '';
        for (const part of response.candidates?.[0]?.content?.parts || []) {
            if (part.inlineData) {
              generatedBase64 = `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
              break;
            }
        }
        
        if (!generatedBase64) throw new Error("No seamless texture generated");

        // 4. Crop the Result
        const outputSize = 1024; // Standard Nano Banana output
        const scale = outputSize / canvasSize;
        
        const cropX = targetX * scale;
        const cropY = targetY * scale;
        const cropW = TARGET_SIZE * scale;
        const cropH = TARGET_SIZE * scale;

        const finalBlock = await cropAndResize(generatedBase64, cropX, cropY, cropW, cropH, TARGET_SIZE, TARGET_SIZE);
        return finalBlock;

    } catch (error) {
        console.error("Seamless Generation Error", error);
        throw error;
    }
};
