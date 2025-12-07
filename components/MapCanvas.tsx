import React, { useRef, useEffect, useState, useCallback } from 'react';
import { MapLayer, Rect, ActiveTool } from '../types';

interface MapCanvasProps {
  width: number;
  height: number;
  layers: MapLayer[];
  selection: Rect | null;
  setSelection: (rect: Rect | null) => void;
  selectedLayerId: string | null;
  onSelectLayer: (id: string | null) => void;
  onMoveLayer: (id: string, x: number, y: number) => void;
  onMoveEnd: () => void;
  activeTool: ActiveTool;
  eraserSize: number;
  onUpdateLayer: (id: string, updates: Partial<MapLayer>) => void;
  onBrushChange: (maskDataUrl: string | null) => void;
  brushMask: string | null;
  viewX: number;
  viewY: number;
}

export const MapCanvas: React.FC<MapCanvasProps> = ({
  width,
  height,
  layers,
  selection,
  setSelection,
  selectedLayerId,
  onSelectLayer,
  onMoveLayer,
  onMoveEnd,
  activeTool,
  eraserSize,
  onUpdateLayer,
  onBrushChange,
  brushMask,
  viewX,
  viewY
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement>(null); // Holds the mask
  
  // Interaction State
  const [interactionMode, setInteractionMode] = useState<'none' | 'selecting' | 'moving_layer' | 'erasing' | 'brushing'>('none');
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [mousePos, setMousePos] = useState({ x: 0, y: 0 });
  
  // For layer moving
  const [dragLayerStartPos, setDragLayerStartPos] = useState({ x: 0, y: 0 });

  // For erasing
  const editingCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [editingLayerId, setEditingLayerId] = useState<string | null>(null);

  // Load images into memory
  const [imageCache, setImageCache] = useState<Record<string, HTMLImageElement>>({});

  useEffect(() => {
    // Preload images and update if source changes
    layers.forEach(layer => {
      const cached = imageCache[layer.id];
      // Reload if not cached or if source string has changed (e.g. after erase)
      if (!cached || cached.src !== layer.imageData) {
        const img = new Image();
        img.onload = () => {
          setImageCache(prev => ({ ...prev, [layer.id]: img }));
        };
        img.src = layer.imageData;
      }
    });
  }, [layers, imageCache]);

  // Init Brush Canvas if not ready
  useEffect(() => {
     if (brushCanvasRef.current) {
         if (!brushMask) {
             const ctx = brushCanvasRef.current.getContext('2d');
             ctx?.clearRect(0, 0, width, height);
         }
     }
  }, [brushMask, width, height]);


  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.clearRect(0, 0, width, height);
    
    // Apply Camera Transform
    ctx.save();
    ctx.translate(-viewX, -viewY);

    // Draw Grid (Background pattern - in world space)
    ctx.lineWidth = 1;
    ctx.beginPath();
    const gridSize = 64;
    // We only need to draw grid lines that are visible in the viewport
    const startX = Math.floor(viewX / gridSize) * gridSize;
    const startY = Math.floor(viewY / gridSize) * gridSize;
    const endX = startX + width + gridSize;
    const endY = startY + height + gridSize;

    for (let x = startX; x <= endX; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
      if (x % 1024 === 0) {
          ctx.strokeStyle = '#4b5563'; // Thicker line for chunk border
          ctx.lineWidth = 2;
      } else {
          ctx.strokeStyle = '#1f2937'; // Faint line for normal grid
          ctx.lineWidth = 1;
      }
      ctx.stroke();
    }
    for (let y = startY; y <= endY; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(startX, y);
      ctx.lineTo(endX, y);
      if (y % 1024 === 0) {
          ctx.strokeStyle = '#4b5563';
          ctx.lineWidth = 2;
      } else {
          ctx.strokeStyle = '#1f2937';
          ctx.lineWidth = 1;
      }
      ctx.stroke();
    }

    // Draw Layers sorted by Z-Index
    const sortedLayers = [...layers].sort((a, b) => a.zIndex - b.zIndex);
    
    sortedLayers.forEach(layer => {
      if (!layer.visible) return;
      
      // Optimization: Only draw if inside viewport
      if (layer.x + layer.width < viewX || layer.x > viewX + width || 
          layer.y + layer.height < viewY || layer.y > viewY + height) {
           return;
      }
      
      // If we are currently erasing this layer, draw from the temp canvas instead of cache
      if (layer.id === editingLayerId && editingCanvasRef.current) {
          ctx.drawImage(editingCanvasRef.current, layer.x, layer.y, layer.width, layer.height);
      } else {
          const img = imageCache[layer.id];
          if (img && img.complete) {
            ctx.drawImage(img, layer.x, layer.y, layer.width, layer.height);
          }
      }
        
      // Highlight selected layer
      if (selectedLayerId === layer.id) {
        ctx.strokeStyle = activeTool === 'eraser' ? '#ef4444' : '#3b82f6'; // Red for eraser, Blue for pointer
        ctx.lineWidth = 2;
        ctx.strokeRect(layer.x, layer.y, layer.width, layer.height);
        
        // Add handles only if using pointer and in pointer mode
        if (activeTool === 'pointer') {
            ctx.fillStyle = '#3b82f6';
            const handleSize = 6;
            ctx.fillRect(layer.x - handleSize/2, layer.y - handleSize/2, handleSize, handleSize);
            ctx.fillRect(layer.x + layer.width - handleSize/2, layer.y - handleSize/2, handleSize, handleSize);
            ctx.fillRect(layer.x - handleSize/2, layer.y + layer.height - handleSize/2, handleSize, handleSize);
            ctx.fillRect(layer.x + layer.width - handleSize/2, layer.y + layer.height - handleSize/2, handleSize, handleSize);
        }
      }
    });

    ctx.restore(); // Back to screen space for UI elements

    // Draw Brush Overlay (Screen Space)
    if (brushCanvasRef.current) {
        ctx.drawImage(brushCanvasRef.current, 0, 0);
    }

    // Draw active selection (Rectangle Tool Box) - Screen Space relative to view
    if (selection) {
      const screenX = selection.x - viewX;
      const screenY = selection.y - viewY;
      
      ctx.fillStyle = 'rgba(59, 130, 246, 0.2)'; 
      ctx.strokeStyle = '#60a5fa'; 
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.fillRect(screenX, screenY, selection.width, selection.height);
      ctx.strokeRect(screenX, screenY, selection.width, selection.height);
      ctx.setLineDash([]);
      
      // Dimensions label
      ctx.fillStyle = '#1e3a8a';
      ctx.fillRect(screenX, screenY - 25, 80, 20);
      ctx.fillStyle = '#fff';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${Math.round(selection.width)}x${Math.round(selection.height)}`, screenX + 5, screenY - 10);
    }
    
    // Draw drag selection box (Creating rectangle)
    if (interactionMode === 'selecting' && !selection) {
       // Drag is in screen space
       const w = mousePos.x - startPos.x;
       const h = mousePos.y - startPos.y;
       ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
       ctx.strokeStyle = '#60a5fa';
       ctx.setLineDash([5, 5]);
       ctx.strokeRect(startPos.x, startPos.y, w, h);
       ctx.fillRect(startPos.x, startPos.y, w, h);
       ctx.setLineDash([]);
    }

    // Draw Tool Cursors (Screen Space)
    if (activeTool === 'eraser' || activeTool === 'brush') {
        ctx.beginPath();
        const r = eraserSize / 2;
        ctx.arc(mousePos.x, mousePos.y, r, 0, Math.PI * 2);
        
        if (activeTool === 'eraser') {
            ctx.strokeStyle = '#ef4444';
            ctx.fillStyle = 'rgba(239, 68, 68, 0.2)';
        } else {
            ctx.strokeStyle = '#f472b6'; // pink-400
            ctx.fillStyle = 'rgba(244, 114, 182, 0.2)';
        }
        
        ctx.lineWidth = 1;
        ctx.fill();
        ctx.stroke();
    }

  }, [width, height, layers, imageCache, selectedLayerId, selection, interactionMode, mousePos, startPos, activeTool, eraserSize, editingLayerId, brushMask, viewX, viewY]);

  useEffect(() => {
    let animationFrameId: number;
    const render = () => {
      draw();
      animationFrameId = requestAnimationFrame(render);
    };
    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [draw]);

  const getCanvasCoords = (e: React.MouseEvent) => {
    if (!canvasRef.current) return { x: 0, y: 0 };
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const screenPos = getCanvasCoords(e);
    const worldPos = { x: screenPos.x + viewX, y: screenPos.y + viewY };
    
    setStartPos(screenPos);
    
    // --- TOOL: ERASER ---
    if (activeTool === 'eraser') {
        const sortedLayers = [...layers].sort((a, b) => b.zIndex - a.zIndex);
        const targetLayer = sortedLayers.find(l => {
            if (!l.visible) return false;
            return (worldPos.x >= l.x && worldPos.x <= l.x + l.width && worldPos.y >= l.y && worldPos.y <= l.y + l.height);
        });

        if (targetLayer) {
            onSelectLayer(targetLayer.id);
            setEditingLayerId(targetLayer.id);
            setInteractionMode('erasing');

            const img = imageCache[targetLayer.id];
            if (img) {
                const editCanvas = document.createElement('canvas');
                editCanvas.width = img.naturalWidth;
                editCanvas.height = img.naturalHeight;
                const eCtx = editCanvas.getContext('2d');
                if (eCtx) {
                    eCtx.drawImage(img, 0, 0);
                    editingCanvasRef.current = editCanvas;
                    performErase(eCtx, worldPos, targetLayer, img.naturalWidth, img.naturalHeight);
                }
            }
        }
        return;
    }

    // --- TOOL: BRUSH ---
    if (activeTool === 'brush') {
        setInteractionMode('brushing');
        performBrush(screenPos); // Brush on screen canvas
        setSelection(null);
        return;
    }

    // --- TOOL: RECTANGLE ---
    if (activeTool === 'rectangle') {
        setInteractionMode('selecting');
        onSelectLayer(null);
        setSelection(null);
        return;
    }

    // --- TOOL: POINTER (Select & Move) ---
    if (activeTool === 'pointer') {
        const sortedLayers = [...layers].sort((a, b) => b.zIndex - a.zIndex);
        let targetLayer = sortedLayers.find(l => {
            if (!l.visible) return false;
            return (worldPos.x >= l.x && worldPos.x <= l.x + l.width && worldPos.y >= l.y && worldPos.y <= l.y + l.height);
        });

        // Priority to currently selected
        const currentSelected = layers.find(l => l.id === selectedLayerId);
        if (currentSelected && currentSelected.visible) {
            if (worldPos.x >= currentSelected.x && worldPos.x <= currentSelected.x + currentSelected.width && worldPos.y >= currentSelected.y && worldPos.y <= currentSelected.y + currentSelected.height) {
                 targetLayer = currentSelected;
            }
        }

        if (targetLayer && targetLayer.type !== 'base') {
            onSelectLayer(targetLayer.id);
            setInteractionMode('moving_layer');
            setDragLayerStartPos({ x: targetLayer.x, y: targetLayer.y });
        } else {
            onSelectLayer(null);
        }
    }
  };

  const performErase = (ctx: CanvasRenderingContext2D, worldPos: {x: number, y: number}, layer: MapLayer, imgW: number, imgH: number) => {
      const localX = worldPos.x - layer.x;
      const localY = worldPos.y - layer.y;
      const scaleX = imgW / layer.width;
      const scaleY = imgH / layer.height;
      const imgX = localX * scaleX;
      const imgY = localY * scaleY;
      const brushRadius = (eraserSize / 2) * scaleX;

      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(imgX, imgY, brushRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
  };

  const performBrush = (screenPos: {x: number, y: number}) => {
      const ctx = brushCanvasRef.current?.getContext('2d');
      if (ctx) {
          ctx.beginPath();
          ctx.arc(screenPos.x, screenPos.y, eraserSize / 2, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(255, 0, 255, 0.5)'; // Hot pink, semi-transparent
          ctx.fill();
      }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const screenPos = getCanvasCoords(e);
    const worldPos = { x: screenPos.x + viewX, y: screenPos.y + viewY };
    
    setMousePos(screenPos);

    if (interactionMode === 'moving_layer' && selectedLayerId && activeTool === 'pointer') {
        const dx = screenPos.x - startPos.x; // Delta in screen pixels is same as world pixels
        const dy = screenPos.y - startPos.y;
        onMoveLayer(selectedLayerId, dragLayerStartPos.x + dx, dragLayerStartPos.y + dy);
    }

    if (interactionMode === 'erasing' && editingLayerId && editingCanvasRef.current) {
        const layer = layers.find(l => l.id === editingLayerId);
        const ctx = editingCanvasRef.current.getContext('2d');
        if (layer && ctx) {
            performErase(ctx, worldPos, layer, editingCanvasRef.current.width, editingCanvasRef.current.height);
        }
    }

    if (interactionMode === 'brushing') {
        performBrush(screenPos);
    }
  };

  const handleMouseUp = () => {
    // Commit Move
    if (interactionMode === 'moving_layer') {
        onMoveEnd();
    }

    // Commit Rectangle Selection
    if (interactionMode === 'selecting') {
      const w = mousePos.x - startPos.x;
      const h = mousePos.y - startPos.y;
      if (Math.abs(w) > 10 && Math.abs(h) > 10) {
        // Selection Rect in WORLD coordinates
        setSelection({
          x: (w < 0 ? mousePos.x : startPos.x) + viewX,
          y: (h < 0 ? mousePos.y : startPos.y) + viewY,
          width: Math.abs(w),
          height: Math.abs(h)
        });
      }
    }

    // Commit Erase
    if (interactionMode === 'erasing' && editingLayerId && editingCanvasRef.current) {
        const newData = editingCanvasRef.current.toDataURL();
        onUpdateLayer(editingLayerId, { imageData: newData });
        setEditingLayerId(null);
        editingCanvasRef.current = null;
    }

    // Commit Brush
    if (interactionMode === 'brushing' && brushCanvasRef.current) {
        const maskData = brushCanvasRef.current.toDataURL();
        onBrushChange(maskData);
    }
    
    setInteractionMode('none');
  };

  return (
    <div 
      ref={containerRef} 
      className="relative overflow-hidden bg-gray-950 flex-1 flex items-center justify-center p-0 shadow-inner"
      style={{
        backgroundImage: 'radial-gradient(#1f2937 1px, transparent 1px)',
        backgroundSize: '20px 20px',
        cursor: (activeTool === 'eraser' || activeTool === 'brush') ? 'none' : 'default'
      }}
    >
      <div className="relative shadow-2xl border-4 border-gray-800 bg-black">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
          className="block z-10 relative"
          style={{ cursor: (activeTool === 'eraser' || activeTool === 'brush') ? 'none' : (interactionMode === 'moving_layer' ? 'move' : 'crosshair') }}
        />
        
        {/* Offscreen canvas for brush mask state - Viewport sized */}
        <canvas 
            ref={brushCanvasRef}
            width={width}
            height={height}
            className="hidden pointer-events-none" 
        />
        
        {/* Coordinate Display */}
        <div className="absolute top-2 left-2 px-2 py-1 bg-black/60 text-white text-xs rounded pointer-events-none select-none z-20">
            View: {Math.round(viewX)},{Math.round(viewY)}
        </div>
      </div>
    </div>
  );
};