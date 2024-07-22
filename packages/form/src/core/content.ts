import { createContext } from 'react';
import type { FormInstance } from './type';

export const FormContext = createContext(undefined as unknown as FormInstance);
