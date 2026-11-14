import type { ReactNode } from 'react'
import { Armchair, Baby, Bath, Bed, Box, Columns3, CookingPot, Flower2, Lamp, Laptop, Package, Refrigerator, Shirt, Sofa, Sparkles, Table2, TreePine, Tv } from 'lucide-react'
import type { AssetCategory } from '@core/types'

/** category icons: filters and the placeholder of assets without a (loadable) thumbnail */
export const ASSET_ICONS: Record<AssetCategory, ReactNode> = {
  sofa: <Sofa />,
  armchair: <Armchair />,
  chair: <Armchair />,
  table: <Table2 />,
  bed: <Bed />,
  storage: <Package />,
  kitchen: <CookingPot />,
  appliance: <Refrigerator />,
  bathroom: <Bath />,
  lighting: <Lamp />,
  decor: <Sparkles />,
  plant: <Flower2 />,
  textile: <Shirt />,
  electronics: <Tv />,
  outdoor: <TreePine />,
  kids: <Baby />,
  office: <Laptop />,
  structure: <Columns3 />,
  other: <Box />,
}

export function assetIcon(category: AssetCategory | undefined): ReactNode {
  return (category && ASSET_ICONS[category]) ?? <Box />
}
