import React from 'react';
import { createRoot } from 'react-dom/client';
import { InvoiceLink } from './InvoiceActions';
import MobileApp from './MobileApp';

createRoot(document.getElementById('root')!).render(<React.StrictMode><InvoiceLink/><MobileApp/></React.StrictMode>);
