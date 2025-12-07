
import React, { useState, useEffect } from 'react';
import { MapCanvas } from './components/MapCanvas';
import { LayerPanel } from './components/LayerPanel';
import { MapLayer, Rect, MapSettings, ActiveTool, DebugLog } from './types';
import { generateMapAsset, generateBaseTexture, generateSeamlessTexture } from './services/geminiService';
import { removeMagentaBackground, compositeLayers, cropAndResize, createDifferenceLayer, getContentBounds, overlayImage, getCompositeRect } from './services/imageUtils';
import { Loader2, Wand2, X, Download, Map as MapIcon, RotateCcw, FolderArchive, Eraser, MousePointer2, Undo2, Redo2, Settings, BoxSelect, Brush, ArrowBigUp, ArrowBigDown, ArrowBigLeft, ArrowBigRight, Move, Bug } from 'lucide-react';
import JSZip from 'jszip';

export const CANVAS_WIDTH = 1024;
export const CANVAS_HEIGHT = 1024;
// Size of the edge strip to use as context for seamless generation
export const STRIP_SIZE = 256;

export default function App() {
  const [layers, setLayers] = useState<MapLayer[]>([]);
  const [history, setHistory] = useState<MapLayer[][]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [selection, setSelection] = useState<Rect | null>(null);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  
  // Tools
  const [activeTool, setActiveTool] = useState<ActiveTool>('pointer');
  const [eraserSize, setEraserSize] = useState(30);
  const [brushMask, setBrushMask] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // View State (Free Camera)
  const [viewState, setViewState] = useState({ x: 0, y: 0 });
  const viewX = viewState.x;
  const viewY = viewState.y;

  // Settings
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [mapSettings, setMapSettings] = useState<MapSettings>({
      artStyle: 'Professional 2D RPG game art, semi-realistic with hand-painted details',
      projection: 'Top-down orthographic (Bird\'s eye view)',
      sunDirection: 'Top-Left'
  });

  // Base Terrain Modal State
  const [isBaseModalOpen, setIsBaseModalOpen] = useState(false);
  const [basePrompt, setBasePrompt] = useState('');
  const [lastBasePrompt, setLastBasePrompt] = useState('grassland'); // Store for extending map
  
  // Debug State
  const [debugLog, setDebugLog] = useState<DebugLog | null>(null);
  const [isDebugOpen, setIsDebugOpen] = useState(false);

  // Initial setup: Base layer
  useEffect(() => {
    if (layers.length === 0 && history.length === 0) {
       const canvas = document.createElement('canvas');
       canvas.width = 64; 
       canvas.height = 64;
       const ctx = canvas.getContext('2d');
       if (ctx) {
           ctx.fillStyle = '#1a2e1a'; 
           ctx.fillRect(0, 0, 64, 64);
           ctx.fillStyle = '#223822';
           ctx.fillRect(0, 0, 32, 32);
           ctx.fillRect(32, 32, 32, 32);
       }
       
       const baseLayer: MapLayer = {
           id: 'layer-base-0-0',
           name: 'Base Start',
           type: 'base',
           imageData: canvas.toDataURL(),
           x: 0,
           y: 0,
           width: CANVAS_WIDTH,
           height: CANVAS_HEIGHT,
           visible: true,
           zIndex: 0
       };
       
       const initialLayers = [baseLayer];
       setLayers(initialLayers);
       setHistory([initialLayers]);
       setHistoryIndex(0);
    }
  }, []);

  // Keyboard Navigation (Panning)
  useEffect(() => {
      const handleKeyDown = (e: KeyboardEvent) => {
          if (document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA') return;
          
          const step = e.shiftKey ? 128 : 32;
          if (e.key === 'ArrowUp') setViewState(p => ({ ...p, y: p.y - step }));
          if (e.key === 'ArrowDown') setViewState(p => ({ ...p, y: p.y + step }));
          if (e.key === 'ArrowLeft') setViewState(p => ({ ...p, x: p.x - step }));
          if (e.key === 'ArrowRight') setViewState(p => ({ ...p, x: p.x + step }));
      };
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleWheel = (e: React.WheelEvent) => {
      if (e.ctrlKey) return; 
      setViewState(p => ({
          x: p.x + e.deltaX,
          y: p.y + e.deltaY
      }));
  };

  const addToHistory = (newLayers: MapLayer[]) => {
      const newHistory = history.slice(0, historyIndex + 1);
      newHistory.push(newLayers);
      setHistory(newHistory);
      setHistoryIndex(newHistory.length - 1);
      setLayers(newLayers);
  };

  const handleUndo = () => {
      if (historyIndex > 0) {
          const newIndex = historyIndex - 1;
          setHistoryIndex(newIndex);
          setLayers(history[newIndex]);
          setSelection(null);
      }
  };

  const handleRedo = () => {
      if (historyIndex < history.length - 1) {
          const newIndex = historyIndex + 1;
          setHistoryIndex(newIndex);
          setLayers(history[newIndex]);
          setSelection(null);
      }
  };

  const handleToolChange = (tool: ActiveTool) => {
      setActiveTool(tool);
      if (tool !== 'rectangle') setSelection(null);
      if (tool !== 'brush') setBrushMask(null);
  }

  const handleNavigate = async (direction: 'top' | 'bottom' | 'left' | 'right') => {
      // Snap current view to grid to find "Current Block"
      const currentGridX = Math.round(viewX / CANVAS_WIDTH);
      const currentGridY = Math.round(viewY / CANVAS_HEIGHT);

      let nextGridX = currentGridX;
      let nextGridY = currentGridY;

      if (direction === 'top') nextGridY -= 1;
      if (direction === 'bottom') nextGridY += 1;
      if (direction === 'left') nextGridX -= 1;
      if (direction === 'right') nextGridX += 1;

      // Target Coordinates for the NEW layer
      const targetX = nextGridX * CANVAS_WIDTH;
      const targetY = nextGridY * CANVAS_HEIGHT;

      // Move Camera to center of new area immediately
      setViewState({ x: targetX, y: targetY });

      // Check if base exists for this grid (fuzzy check due to potential float drift)
      const exists = layers.some(l => 
          l.type === 'base' && 
          Math.abs(l.x - targetX) < 50 && 
          Math.abs(l.y - targetY) < 50
      );

      if (!exists) {
          setIsGenerating(true);
          try {
              // Check ALL neighbors to build context
              // Use slightly larger epsilon for drift safety
              const EPSILON = 100;
              const neighbors: { left?: string, right?: string, top?: string, bottom?: string } = {};
              
              // 1. Check LEFT Neighbor (Target X - 1024)
              const hasLeft = layers.some(l => l.type === 'base' && Math.abs(l.x - (targetX - CANVAS_WIDTH)) < EPSILON && Math.abs(l.y - targetY) < EPSILON);
              if (hasLeft) {
                  const rect = { x: targetX - STRIP_SIZE, y: targetY, width: STRIP_SIZE, height: CANVAS_HEIGHT };
                  neighbors.left = await getCompositeRect(rect, layers);
              }

              // 2. Check RIGHT Neighbor (Target X + 1024)
              const hasRight = layers.some(l => l.type === 'base' && Math.abs(l.x - (targetX + CANVAS_WIDTH)) < EPSILON && Math.abs(l.y - targetY) < EPSILON);
              if (hasRight) {
                  const rect = { x: targetX + CANVAS_WIDTH, y: targetY, width: STRIP_SIZE, height: CANVAS_HEIGHT };
                  neighbors.right = await getCompositeRect(rect, layers);
              }

              // 3. Check TOP Neighbor (Target Y - 1024)
              const hasTop = layers.some(l => l.type === 'base' && Math.abs(l.x - targetX) < EPSILON && Math.abs(l.y - (targetY - CANVAS_HEIGHT)) < EPSILON);
              if (hasTop) {
                  const rect = { x: targetX, y: targetY - STRIP_SIZE, width: CANVAS_WIDTH, height: STRIP_SIZE };
                  neighbors.top = await getCompositeRect(rect, layers);
              }

              // 4. Check BOTTOM Neighbor (Target Y + 1024)
              const hasBottom = layers.some(l => l.type === 'base' && Math.abs(l.x - targetX) < EPSILON && Math.abs(l.y - (targetY + CANVAS_HEIGHT)) < EPSILON);
              if (hasBottom) {
                  const rect = { x: targetX, y: targetY + CANVAS_HEIGHT, width: CANVAS_WIDTH, height: STRIP_SIZE };
                  neighbors.bottom = await getCompositeRect(rect, layers);
              }

              // Generate
              const newBaseImage = await generateSeamlessTexture(
                  neighbors, 
                  mapSettings, 
                  lastBasePrompt,
                  (log) => {
                      setDebugLog(log);
                      console.log("DEBUG LOG:", log);
                  }
              );

              // Add New Layer
              const newLayer: MapLayer = {
                  id: `layer-base-${nextGridX}-${nextGridY}`,
                  name: `Base (${nextGridX},${nextGridY})`,
                  type: 'base',
                  imageData: newBaseImage,
                  x: targetX,
                  y: targetY,
                  width: CANVAS_WIDTH,
                  height: CANVAS_HEIGHT,
                  visible: true,
                  zIndex: 0 
              };

              const newLayers = [...layers, newLayer];
              addToHistory(newLayers);

          } catch (e: any) {
              console.error(e);
              setError("Failed to generate neighbor: " + e.message);
          } finally {
              setIsGenerating(false);
          }
      }
  };

  const handleGenerateAsset = async () => {
    if (!prompt.trim()) return;
    
    setIsGenerating(true);
    setError(null);
    
    try {
      let finalImageData = '';
      let targetX = viewX + (CANVAS_WIDTH / 2) - 128;
      let targetY = viewY + (CANVAS_HEIGHT / 2) - 128;
      let targetW = 256;
      let targetH = 256;

      const debugCallback = (log: DebugLog) => {
          setDebugLog(log);
          console.log("DEBUG LOG:", log);
      };

      // MODE 1: BRUSH MASK GENERATION
      if (brushMask && activeTool === 'brush') {
          // Brush mask is in SCREEN SPACE (0,0 to 1024,1024 relative to view)
          const bounds = await getContentBounds(brushMask, CANVAS_WIDTH, CANVAS_HEIGHT);
          
          if (!bounds) throw new Error("Paint something first!");
          
          // Bounds are relative to Viewport (0,0). Add ViewX/Y to get World Coords.
          const worldBoundsX = bounds.x + viewX;
          const worldBoundsY = bounds.y + viewY;

          // Helper: Get composite of current viewport
          const viewportRect = { x: viewX, y: viewY, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
          const viewportImage = await getCompositeRect(viewportRect, layers);
          
          // Overlay the brush mask (which matches viewport size)
          const guidanceImage = await overlayImage(viewportImage, brushMask);

          // Now crop the relevant square from this Viewport-sized image
          const size = Math.max(bounds.width, bounds.height);
          const padding = 20; 
          const cropSize = size + (padding * 2);
          
          // Crop center relative to Viewport
          const cx = bounds.x + bounds.width / 2;
          const cy = bounds.y + bounds.height / 2;
          const cropX = cx - cropSize / 2;
          const cropY = cy - cropSize / 2;

          const GENERATION_SIZE = 512;
          
          const guidanceCrop = await cropAndResize(
              guidanceImage, 
              cropX, cropY, cropSize, cropSize, 
              GENERATION_SIZE, GENERATION_SIZE
          );
          
          const cleanCrop = await cropAndResize(
              viewportImage,
              cropX, cropY, cropSize, cropSize, 
              GENERATION_SIZE, GENERATION_SIZE
          );

          const rawGeneratedImage = await generateMapAsset(prompt, mapSettings, guidanceCrop, debugCallback);
          finalImageData = await createDifferenceLayer(cleanCrop, rawGeneratedImage);

          // Final World Coordinates
          targetX = viewX + cropX;
          targetY = viewY + cropY;
          targetW = cropSize;
          targetH = cropSize;

          setBrushMask(null);
      } 
      // MODE 2: RECTANGLE SELECTION
      else if (selection) {
          // Selection is in WORLD coordinates
          targetX = selection.x;
          targetY = selection.y;
          targetW = selection.width;
          targetH = selection.height;

          const size = Math.max(selection.width, selection.height);
          const centerX = selection.x + selection.width / 2;
          const centerY = selection.y + selection.height / 2;
          
          // Context Capture: Crop from WORLD composite
          const contextRect = { 
              x: centerX - size / 2, 
              y: centerY - size / 2, 
              width: size, 
              height: size 
          };
          
          targetX = contextRect.x;
          targetY = contextRect.y;
          targetW = size;
          targetH = size;

          const contextCrop = await getCompositeRect(contextRect, layers);
          const contextResized = await cropAndResize(contextCrop, 0, 0, size, size, 512, 512);

          const rawGeneratedImage = await generateMapAsset(prompt, mapSettings, contextResized, debugCallback);
          finalImageData = await createDifferenceLayer(contextResized, rawGeneratedImage);
      } 
      // MODE 3: ISOLATED (FALLBACK)
      else {
          const rawImageData = await generateMapAsset(prompt, mapSettings, undefined, debugCallback);
          // Changed to remove Magenta background
          finalImageData = await removeMagentaBackground(rawImageData);
      }
      
      const newLayer: MapLayer = {
        id: `layer-${Date.now()}`,
        name: prompt,
        type: 'object',
        imageData: finalImageData,
        x: targetX,
        y: targetY,
        width: targetW,
        height: targetH,
        visible: true,
        zIndex: layers.length + 10
      };
      
      const newLayers = [...layers, newLayer];
      addToHistory(newLayers);
      
      setSelection(null); 
      setPrompt('');
      setActiveTool('pointer');
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to generate image');
    } finally {
      setIsGenerating(false);
    }
  };
  
  const handleGenerateBase = async () => {
      if (!basePrompt.trim()) return;
      setIsBaseModalOpen(false); 
      setIsGenerating(true);
      setError(null);
      setLastBasePrompt(basePrompt);
      
      try {
          const imageData = await generateBaseTexture(basePrompt, mapSettings, (log) => {
              setDebugLog(log);
              console.log("DEBUG LOG:", log);
          });
          
          // Snap view to grid
          const snapX = Math.round(viewX / CANVAS_WIDTH) * CANVAS_WIDTH;
          const snapY = Math.round(viewY / CANVAS_HEIGHT) * CANVAS_HEIGHT;
          
          // Remove existing base at this location
          const prevLayers = layers.filter(l => !(l.type === 'base' && Math.abs(l.x - snapX) < 10 && Math.abs(l.y - snapY) < 10));
          
          const baseLayer: MapLayer = {
               id: `layer-base-${snapX}-${snapY}-${Date.now()}`,
               name: `Base: ${basePrompt}`,
               type: 'base',
               imageData: imageData,
               x: snapX,
               y: snapY,
               width: CANVAS_WIDTH,
               height: CANVAS_HEIGHT,
               visible: true,
               zIndex: 0
          };
          
          const newLayers = [baseLayer, ...prevLayers];
          addToHistory(newLayers);
          setBasePrompt('');
      } catch (err: any) {
        setError(err.message || "Failed to generate base");
      } finally {
        setIsGenerating(false);
      }
  }

  const handleDeleteLayer = (id: string) => {
    const newLayers = layers.filter(l => l.id !== id);
    addToHistory(newLayers);
    if (selectedLayerId === id) setSelectedLayerId(null);
  };

  const handleToggleVisibility = (id: string) => {
    const newLayers = layers.map(l => l.id === id ? { ...l, visible: !l.visible } : l);
    addToHistory(newLayers);
  };
  
  const handleMoveLayer = (id: string, direction: 'up' | 'down') => {};

  const updateLayerPosition = (id: string, x: number, y: number) => {
      setLayers(prev => prev.map(l => l.id === id ? { ...l, x, y } : l));
  };

  const handleMoveEnd = () => {
      addToHistory(layers);
  };
  
  const updateLayerData = (id: string, updates: Partial<MapLayer>) => {
      const newLayers = layers.map(l => l.id === id ? { ...l, ...updates } : l);
      addToHistory(newLayers);
  };

  const handleExportMerged = () => {
      compositeLayers(0, 0, layers).then(dataUrl => {
          const link = document.createElement('a');
          link.download = 'map_merged_full.png';
          link.href = dataUrl;
          link.click();
      });
  };

  const handleExportZip = async () => {
      try {
        const zip = new JSZip();
        const mergedDataUrl = await compositeLayers(0, 0, layers);
        zip.file("map_merged_full.png", mergedDataUrl.split(',')[1], {base64: true});
        const layersFolder = zip.folder("layers");
        if (layersFolder) {
            layers.forEach(layer => {
                if (!layer.visible) return;
                const safeName = layer.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
                const filename = `${layer.zIndex}_${safeName}_${layer.id.substring(0,6)}.png`;
                const data = layer.imageData.split(',')[1];
                layersFolder.file(filename, data, {base64: true});
            });
        }
        const content = await zip.generateAsync({type:"blob"});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(content);
        link.download = "map_project_export.zip";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (e) {
          console.error("Export failed", e);
          setError("Failed to create ZIP export");
      }
  };

  const showPromptInput = selection || (brushMask && activeTool === 'brush');

  return (
    <div className="flex flex-col h-screen text-gray-100 font-sans selection:bg-blue-500 selection:text-white">
      {/* Header */}
      <header className="h-16 border-b border-gray-800 bg-gray-900 flex items-center justify-between px-6 shrink-0 z-10">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-600 rounded-lg">
            <MapIcon size={24} className="text-white" />
          </div>
          <h1 className="text-xl font-bold tracking-tight">MapGen <span className="text-blue-500">AI</span></h1>
        </div>
        
        {/* Toolbar */}
        <div className="flex items-center gap-4 bg-gray-800 px-3 py-1.5 rounded-xl border border-gray-700">
           {/* Undo/Redo */}
           <div className="flex bg-gray-900 rounded-lg p-1 border border-gray-700 mr-2">
               <button onClick={handleUndo} disabled={historyIndex <= 0} className="p-2 text-gray-400 hover:text-white disabled:opacity-30 transition-colors" title="Undo">
                   <Undo2 size={16} />
               </button>
               <button onClick={handleRedo} disabled={historyIndex >= history.length - 1} className="p-2 text-gray-400 hover:text-white disabled:opacity-30 transition-colors" title="Redo">
                   <Redo2 size={16} />
               </button>
           </div>

           {/* Tool Toggle */}
           <div className="flex bg-gray-900 rounded-lg p-1 border border-gray-700">
              <button 
                onClick={() => handleToolChange('pointer')}
                className={`p-2 rounded flex items-center gap-2 text-sm font-medium transition-all ${activeTool === 'pointer' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                title="Select & Move Layers"
              >
                <MousePointer2 size={16} />
              </button>
              <button 
                onClick={() => handleToolChange('rectangle')}
                className={`p-2 rounded flex items-center gap-2 text-sm font-medium transition-all ${activeTool === 'rectangle' ? 'bg-blue-600 text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                title="Rectangle Selection"
              >
                <BoxSelect size={16} />
              </button>
              <button 
                onClick={() => handleToolChange('brush')}
                className={`p-2 rounded flex items-center gap-2 text-sm font-medium transition-all ${activeTool === 'brush' ? 'bg-pink-600 text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                title="Brush (Paint to Fill)"
              >
                <Brush size={16} />
              </button>
              <div className="w-px bg-gray-700 mx-1"></div>
              <button 
                onClick={() => handleToolChange('eraser')}
                className={`p-2 rounded flex items-center gap-2 text-sm font-medium transition-all ${activeTool === 'eraser' ? 'bg-red-600 text-white shadow-md' : 'text-gray-400 hover:text-white hover:bg-gray-800'}`}
                title="Eraser"
              >
                <Eraser size={16} />
              </button>
           </div>
           
           {/* Size Slider */}
           {(activeTool === 'eraser' || activeTool === 'brush') && (
               <div className="flex items-center gap-2 pl-2 border-l border-gray-700">
                   <span className="text-xs text-gray-400 uppercase font-bold tracking-wider">Size</span>
                   <input 
                      type="range" 
                      min="5" 
                      max="100" 
                      value={eraserSize} 
                      onChange={(e) => setEraserSize(Number(e.target.value))}
                      className={`w-24 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer ${activeTool === 'brush' ? 'accent-pink-500' : 'accent-red-500'}`}
                   />
                   <span className="text-xs text-gray-400 w-6 text-right">{eraserSize}</span>
               </div>
           )}
        </div>
        
        <div className="flex items-center gap-4">
            {debugLog && (
                <button onClick={() => setIsDebugOpen(true)} className="p-2 text-yellow-400 hover:text-yellow-200 hover:bg-gray-800 rounded-lg transition-colors" title="Debug API Request">
                    <Bug size={20} />
                </button>
            )}
             <button onClick={() => setIsSettingsOpen(true)} className="p-2 text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors" title="Settings">
                <Settings size={20} />
            </button>
            <button onClick={() => setIsBaseModalOpen(true)} className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors border border-gray-700">
                <RotateCcw size={16} />
                Regenerate Base
            </button>
            <div className="h-6 w-px bg-gray-700"></div>
            <button onClick={handleExportMerged} className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors border border-gray-700">
                <Download size={16} />
                Image
            </button>
            <button onClick={handleExportZip} className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors shadow-lg shadow-blue-900/20">
                <FolderArchive size={16} />
                Export Zip
            </button>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex flex-1 overflow-hidden relative group" onWheel={handleWheel}>
        
        {/* Canvas Wrapper - Contains Map and UI Overlays */}
        <div className="relative flex-1 flex flex-col h-full overflow-hidden bg-gray-950">
            <MapCanvas 
                width={CANVAS_WIDTH}
                height={CANVAS_HEIGHT}
                layers={layers}
                selection={selection}
                setSelection={setSelection}
                selectedLayerId={selectedLayerId}
                onSelectLayer={setSelectedLayerId}
                onMoveLayer={updateLayerPosition}
                onMoveEnd={handleMoveEnd}
                activeTool={activeTool}
                eraserSize={eraserSize}
                onUpdateLayer={updateLayerData}
                onBrushChange={setBrushMask}
                brushMask={brushMask}
                viewX={viewX}
                viewY={viewY}
            />

            {/* Navigation Arrows */}
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-10">
                <button 
                    onClick={() => handleNavigate('top')}
                    className="absolute top-4 pointer-events-auto p-3 bg-gray-800/80 hover:bg-blue-600 text-white rounded-full shadow-lg transition-all border border-gray-600 hover:scale-110 flex flex-col items-center gap-1 group"
                    title="Jump North / Generate"
                >
                    <ArrowBigUp size={24} />
                    <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">Jump</span>
                </button>
                <button 
                    onClick={() => handleNavigate('bottom')}
                    className="absolute bottom-4 pointer-events-auto p-3 bg-gray-800/80 hover:bg-blue-600 text-white rounded-full shadow-lg transition-all border border-gray-600 hover:scale-110 flex flex-col items-center gap-1 group"
                    title="Jump South / Generate"
                >
                    <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity">Jump</span>
                    <ArrowBigDown size={24} />
                </button>
                <button 
                    onClick={() => handleNavigate('left')}
                    className="absolute left-4 pointer-events-auto p-3 bg-gray-800/80 hover:bg-blue-600 text-white rounded-full shadow-lg transition-all border border-gray-600 hover:scale-110 flex flex-row items-center gap-1 group"
                    title="Jump West / Generate"
                >
                    <ArrowBigLeft size={24} />
                    <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity writing-mode-vertical">Jump</span>
                </button>
                <button 
                    onClick={() => handleNavigate('right')}
                    className="absolute right-4 pointer-events-auto p-3 bg-gray-800/80 hover:bg-blue-600 text-white rounded-full shadow-lg transition-all border border-gray-600 hover:scale-110 flex flex-row items-center gap-1 group"
                    title="Jump East / Generate"
                >
                    <span className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity writing-mode-vertical">Jump</span>
                    <ArrowBigRight size={24} />
                </button>

                {/* Pan hint */}
                <div className="absolute bottom-8 right-20 text-gray-500 text-xs flex items-center gap-2 opacity-50 pointer-events-none">
                    <Move size={12}/> Use Arrow Keys or Mouse Wheel to Pan
                </div>
            </div>
            
            {/* Asset Generation Bar - Also inside wrapper */}
            {showPromptInput && (
                <div className="absolute bottom-8 left-1/2 -translate-x-1/2 w-full max-w-2xl px-4 z-30">
                <div className="bg-gray-900/95 backdrop-blur-md border border-gray-700 rounded-2xl shadow-2xl p-4 flex flex-col gap-3 animate-in slide-in-from-bottom-5 fade-in duration-200">
                    <div className="flex justify-between items-center text-sm text-gray-400 px-1">
                    <span className="flex items-center gap-2">
                        {activeTool === 'brush' ? (
                            <><Brush size={14} className="text-pink-400"/> Paint Fill Mode</>
                        ) : (
                            <><BoxSelect size={14} className="text-blue-400"/> Rectangle Generation Mode</>
                        )}
                    </span>
                    <button 
                        onClick={() => { setSelection(null); setBrushMask(null); }} 
                        className="hover:text-white"
                    >
                        <X size={16} />
                    </button>
                    </div>
                    
                    <div className="flex gap-2">
                    <input
                        type="text"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && handleGenerateAsset()}
                        placeholder={activeTool === 'brush' ? "Describe what to fill in the pink area..." : "Describe object to place..."}
                        className="flex-1 bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                        disabled={isGenerating}
                        autoFocus
                    />
                    <button
                        onClick={handleGenerateAsset}
                        disabled={isGenerating || !prompt.trim()}
                        className={`text-white px-6 rounded-xl font-medium transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 ${activeTool === 'brush' ? 'bg-gradient-to-r from-pink-600 to-purple-600 hover:from-pink-500 hover:to-purple-500 shadow-pink-900/50' : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-blue-900/50'}`}
                    >
                        {isGenerating ? <Loader2 className="animate-spin" size={20} /> : <Wand2 size={20} />}
                        Generate
                    </button>
                    </div>
                </div>
                </div>
            )}
        </div>

        {/* Sidebar */}
        <LayerPanel 
            layers={layers}
            selectedLayerId={selectedLayerId}
            onSelectLayer={setSelectedLayerId}
            onToggleVisibility={handleToggleVisibility}
            onDeleteLayer={handleDeleteLayer}
            onMoveLayer={handleMoveLayer}
        />
      </div>

      {/* Settings Modal */}
      {isSettingsOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="p-6">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-xl font-bold text-white flex items-center gap-2">
                            <Settings size={20} />
                            Map Settings
                        </h2>
                        <button onClick={() => setIsSettingsOpen(false)} className="text-gray-400 hover:text-white">
                            <X size={20} />
                        </button>
                    </div>

                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-1">Art Style</label>
                            <select 
                                value={mapSettings.artStyle}
                                onChange={(e) => setMapSettings({...mapSettings, artStyle: e.target.value})}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                            >
                                <option value="Professional 2D RPG game art, semi-realistic with hand-painted details">Realistic RPG</option>
                                <option value="Dark Fantasy, gritty, high contrast, Diablo-like">Dark Fantasy</option>
                                <option value="Pixel Art, 16-bit retro style">Pixel Art (16-bit)</option>
                                <option value="Watercolor, artistic, painterly style">Watercolor</option>
                                <option value="Vector art, clean lines, cel-shaded">Vector / Cel-Shaded</option>
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-1">View / Projection</label>
                            <select 
                                value={mapSettings.projection}
                                onChange={(e) => setMapSettings({...mapSettings, projection: e.target.value})}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                            >
                                <option value="Top-down orthographic (Bird's eye view)">Top-down Orthographic</option>
                                <option value="Isometric (2.5D view)">Isometric</option>
                                <option value="Sidescroller (Side view platformer)">Sidescroller (Side view platformer)</option>
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-300 mb-1">Sun Direction</label>
                            <select 
                                value={mapSettings.sunDirection}
                                onChange={(e) => setMapSettings({...mapSettings, sunDirection: e.target.value})}
                                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                            >
                                <option value="Top-Left">Top-Left</option>
                                <option value="Top-Right">Top-Right</option>
                                <option value="Directly Above">Directly Above (No Directional Shadows)</option>
                                <option value="Bottom-Right">Bottom-Right</option>
                            </select>
                        </div>
                    </div>

                    <div className="mt-8 flex justify-end">
                        <button 
                            onClick={() => setIsSettingsOpen(false)}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium shadow-lg shadow-blue-900/20"
                        >
                            Done
                        </button>
                    </div>
                </div>
            </div>
        </div>
      )}

      {/* Debug Modal */}
      {isDebugOpen && debugLog && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-4xl h-[80vh] flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="p-4 border-b border-gray-800 flex justify-between items-center bg-gray-800">
                    <h2 className="text-lg font-bold text-white flex items-center gap-2">
                        <Bug size={18} className="text-yellow-400" />
                        Last API Request ({debugLog.type})
                    </h2>
                    <button onClick={() => setIsDebugOpen(false)} className="text-gray-400 hover:text-white">
                        <X size={20} />
                    </button>
                </div>
                <div className="flex-1 overflow-auto p-6 flex flex-col md:flex-row gap-6">
                    <div className="flex-1 space-y-2">
                        <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider">Prompt</h3>
                        <div className="bg-gray-950 p-4 rounded-lg border border-gray-800 font-mono text-xs text-green-400 whitespace-pre-wrap">
                            {debugLog.prompt}
                        </div>
                    </div>
                    {debugLog.inputImage && (
                        <div className="flex-1 space-y-2">
                             <h3 className="text-sm font-bold text-gray-400 uppercase tracking-wider">Input Image Sent</h3>
                             <div className="bg-gray-950 p-2 rounded-lg border border-gray-800 flex justify-center">
                                 <img src={debugLog.inputImage} alt="Input to AI" className="max-w-full h-auto max-h-[500px] border border-gray-700" />
                             </div>
                             <p className="text-xs text-gray-500 text-center">This image was sent to Gemini as context.</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
      )}

      {/* Base Terrain Modal */}
      {isBaseModalOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200">
                <div className="p-6">
                    <div className="flex justify-between items-start mb-4">
                        <h2 className="text-xl font-bold text-white">Generate Base Terrain</h2>
                        <button onClick={() => setIsBaseModalOpen(false)} className="text-gray-400 hover:text-white">
                            <X size={20} />
                        </button>
                    </div>
                    <p className="text-gray-400 text-sm mb-4">
                        Describe the base terrain texture for your map. This will fill the current block.
                    </p>
                    
                    <textarea 
                        value={basePrompt}
                        onChange={(e) => setBasePrompt(e.target.value)}
                        placeholder="e.g. Lush green grassy plains with small wildflowers..."
                        className="w-full h-32 bg-gray-800 border border-gray-700 rounded-xl p-4 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none mb-4"
                    />

                    <div className="flex justify-end gap-3">
                        <button 
                            onClick={() => setIsBaseModalOpen(false)}
                            className="px-4 py-2 text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors"
                        >
                            Cancel
                        </button>
                        <button 
                            onClick={handleGenerateBase}
                            disabled={!basePrompt.trim()}
                            className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium shadow-lg shadow-blue-900/20 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                        >
                           <Wand2 size={16} />
                           Generate Terrain
                        </button>
                    </div>
                </div>
            </div>
        </div>
      )}
      
      {/* Global Loader Overlay */}
      {isGenerating && (
          <div className="absolute inset-0 bg-black/60 z-[60] flex items-center justify-center backdrop-blur-sm">
             <div className="bg-gray-900 border border-gray-800 p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-6 max-w-sm text-center">
                 <div className="relative">
                    <div className="absolute inset-0 bg-blue-500 blur-xl opacity-20 rounded-full"></div>
                    <Loader2 className="animate-spin text-blue-500 relative z-10" size={48} />
                 </div>
                 <div>
                    <h3 className="text-lg font-semibold text-white mb-1">Forging World...</h3>
                    <p className="text-gray-400 text-sm">Expanding boundaries and computing seamless transitions...</p>
                 </div>
             </div>
          </div>
      )}

      {/* Error Toast */}
      {error && (
        <div className="absolute top-20 right-6 bg-red-900/90 border border-red-700 text-white px-4 py-3 rounded-lg shadow-xl z-50 flex items-center gap-3 animate-in slide-in-from-right fade-in">
            <div className="p-1 bg-red-800 rounded-full"><X size={12} /></div>
            <p className="text-sm">{error}</p>
            <button onClick={() => setError(null)} className="ml-2 hover:bg-red-800/50 p-1 rounded">
                <X size={14} />
            </button>
        </div>
      )}
    </div>
  );
}
