import React, { useMemo } from 'react';
import { MapLayer } from '../types';
import { Download, Eye, EyeOff, Trash2 } from 'lucide-react';

interface LayerPanelProps {
  layers: MapLayer[];
  selectedLayerId: string | null;
  onSelectLayer: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onDeleteLayer: (id: string) => void;
  onMoveLayer: (id: string, direction: 'up' | 'down') => void;
}

const BLOCK_SIZE = 1024;

const getBlockId = (layer: MapLayer) => {
    // Calculate center of layer to determine which block it 'belongs' to
    const cx = layer.x + layer.width / 2;
    const cy = layer.y + layer.height / 2;
    const bx = Math.floor(cx / BLOCK_SIZE);
    const by = Math.floor(cy / BLOCK_SIZE);
    return { 
        id: `${bx},${by}`, 
        label: `Block (${bx}, ${by})`,
        bx,
        by
    };
};

export const LayerPanel: React.FC<LayerPanelProps> = ({
  layers,
  selectedLayerId,
  onSelectLayer,
  onToggleVisibility,
  onDeleteLayer,
  onMoveLayer
}) => {
  
  // Group layers by block
  const { blockIds, groupedLayers, blockInfo } = useMemo(() => {
      const groups: Record<string, MapLayer[]> = {};
      const info: Record<string, {label: string, bx: number, by: number}> = {};

      layers.forEach(layer => {
          const { id, label, bx, by } = getBlockId(layer);
          if (!groups[id]) {
              groups[id] = [];
              info[id] = { label, bx, by };
          }
          groups[id].push(layer);
      });

      // Sort blocks: Top-Left to Bottom-Right roughly (Y then X)
      const sortedIds = Object.keys(groups).sort((a, b) => {
          const infoA = info[a];
          const infoB = info[b];
          if (infoA.by !== infoB.by) return infoA.by - infoB.by;
          return infoA.bx - infoB.bx;
      });

      return { blockIds: sortedIds, groupedLayers: groups, blockInfo: info };
  }, [layers]);

  const downloadLayer = (layer: MapLayer) => {
    const link = document.createElement('a');
    link.href = layer.imageData;
    link.download = `${layer.name.replace(/\s+/g, '_')}_${layer.id.substring(0, 4)}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex flex-col h-full bg-gray-900 border-l border-gray-700 w-80 shadow-xl z-20">
      <div className="p-4 border-b border-gray-700 bg-gray-800">
        <h2 className="text-lg font-bold text-white flex items-center gap-2">
          Layers
          <span className="text-xs font-normal text-gray-400 bg-gray-700 px-2 py-0.5 rounded-full">
            {layers.length}
          </span>
        </h2>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2 space-y-6">
        {blockIds.map(blockId => {
            // Sort layers within block by Z-Index (Top to Bottom visually)
            const blockLayers = groupedLayers[blockId].sort((a, b) => b.zIndex - a.zIndex);
            const label = blockInfo[blockId].label;

            return (
                <div key={blockId} className="flex flex-col gap-1">
                     <div className="flex items-center gap-2 px-2 pb-1 border-b border-gray-800/50">
                        <div className="h-2 w-2 rounded-full bg-blue-500/50"></div>
                        <span className="text-xs font-bold text-blue-200/80 uppercase tracking-wider font-mono">{label}</span>
                     </div>
                     
                     <div className="space-y-1 pl-2">
                        {blockLayers.map((layer) => (
                        <div
                            key={layer.id}
                            onClick={() => onSelectLayer(layer.id)}
                            className={`
                            relative flex items-center gap-3 p-2 rounded-lg transition-all border
                            ${selectedLayerId === layer.id 
                                ? 'bg-blue-900/40 border-blue-500/50 shadow-sm' 
                                : 'bg-gray-800/40 border-transparent hover:bg-gray-800 hover:border-gray-700'}
                            `}
                        >
                            {/* Preview Thumbnail */}
                            <div className="w-10 h-10 rounded-md overflow-hidden bg-gray-950 shrink-0 border border-gray-700 shadow-inner">
                            <img 
                                src={layer.imageData} 
                                alt={layer.name} 
                                className="w-full h-full object-cover"
                            />
                            </div>

                            {/* Info */}
                            <div className="flex-1 min-w-0 flex flex-col justify-center">
                            <h3 className="text-sm font-medium text-gray-200 truncate leading-tight mb-0.5">
                                {layer.name}
                            </h3>
                            <p className="text-[10px] text-gray-500 capitalize leading-tight flex items-center gap-1">
                                {layer.type === 'base' && <span className="inline-block w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>}
                                {layer.type}
                            </p>
                            </div>

                            {/* Actions */}
                            <div className="flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button
                                onClick={(e) => { e