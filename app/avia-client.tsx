'use client';

import {useEffect, useState} from 'react';
import App from './avia/App';
import {VoxelBoot} from './avia/VoxelDecor';

export default function AviaClient() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <VoxelBoot/>;
  return <App />;
}
