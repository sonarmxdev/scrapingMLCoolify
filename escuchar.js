const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Ruta principal para scraping
app.post('/scrape', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'URL es requerida'
        });
    }

    console.log('🚀 Iniciando scraping para:', url);
    
    try {
        const result = await scrapeMercadoLibreWithJSON(url);
        
        if (result) {
            res.json({
                success: true,
                data: result,
                message: 'Scraping completado exitosamente'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'No se pudo obtener datos de la página'
            });
        }
    } catch (error) {
        console.error('❌ Error en scraping:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Ruta de salud
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        message: 'Servidor de scraping funcionando',
        timestamp: new Date().toISOString()
    });
});

// Ruta para obtener información específica del producto
app.post('/scrape/product-info', async (req, res) => {
    const { url } = req.body;
    
    if (!url) {
        return res.status(400).json({
            success: false,
            error: 'URL es requerida'
        });
    }

    try {
        const preloadedState = await scrapeMercadoLibreWithJSON(url);
        
        if (preloadedState) {
            const productInfo = extractProductInfo(preloadedState);
            
            res.json({
                success: true,
                data: productInfo,
                message: 'Información del producto obtenida exitosamente'
            });
        } else {
            res.status(500).json({
                success: false,
                error: 'No se pudo obtener datos de la página'
            });
        }
    } catch (error) {
        console.error('❌ Error obteniendo información del producto:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Función auxiliar para esperar
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeMercadoLibreWithJSON(url) {
    console.log('🚀 Iniciando scraping con extracción de JSON...');
    
    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--window-size=1280,800',
            '--single-process'
        ]
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
    // Configurar user agent real
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Configurar timeout
    page.setDefaultTimeout(30000);
    
    // Interceptar requests para mejorar performance
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        // Bloquear recursos innecesarios
        if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });
    
    console.log('📄 Navegando a la página...');
    
    try {
        await page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000 
        });
        
        console.log('✅ Página cargada');
        
        // Esperar a que los elementos críticos carguen
        await page.waitForSelector('body', { timeout: 10000 });
        
        // Esperar un poco más para que cargue el JavaScript
        await page.waitForFunction(
            () => document.readyState === 'complete',
            { timeout: 10000 }
        );
        
        // Esperar adicionalmente
        await wait(3000);
        
        // Manejar popups primero
        await handlePopups(page);
        
        // Intentar múltiples formas de encontrar el JSON
        const preloadedState = await findPreloadedState(page);
        
        if (preloadedState) {
            console.log('✅ JSON __PRELOADED_STATE__ encontrado');
            return preloadedState;
        } else {
            console.log('❌ No se encontró el script __PRELOADED_STATE__');
            // Intentar extraer datos de otra forma
            return await extractDataFromPage(page);
        }
        
    } catch (error) {
        console.error('❌ Error durante el scraping:', error);
        throw error;
    } finally {
        await browser.close();
    }
}

async function findPreloadedState(page) {
    // Método 1: Buscar por ID
    try {
        await page.waitForSelector('#__PRELOADED_STATE__', { timeout: 5000 });
        const state1 = await page.evaluate(() => {
            const scriptElement = document.getElementById('__PRELOADED_STATE__');
            if (scriptElement) {
                try {
                    return JSON.parse(scriptElement.textContent);
                } catch (e) {
                    console.error('Error parseando JSON:', e);
                    return null;
                }
            }
            return null;
        });
        if (state1) return state1;
    } catch (e) {
        console.log('Método 1 falló:', e.message);
    }

    // Método 2: Buscar por contenido en scripts
    try {
        const state2 = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script'));
            for (const script of scripts) {
                const content = script.textContent || script.innerHTML;
                if (content.includes('__PRELOADED_STATE__')) {
                    try {
                        // Buscar patrones comunes
                        const patterns = [
                            /window\.__PRELOADED_STATE__\s*=\s*({[\s\S]*?});/,
                            /__PRELOADED_STATE__\s*=\s*({[\s\S]*?});/,
                            /"pageState":{[\s\S]*?}/,
                        ];
                        
                        for (const pattern of patterns) {
                            const match = content.match(pattern);
                            if (match && match[1]) {
                                return JSON.parse(match[1]);
                            }
                        }
                        
                        // Si no encuentra patrón, intentar extraer objeto JSON completo
                        const jsonStart = content.indexOf('{');
                        const jsonEnd = content.lastIndexOf('}') + 1;
                        if (jsonStart !== -1 && jsonEnd !== -1) {
                            const jsonStr = content.substring(jsonStart, jsonEnd);
                            return JSON.parse(jsonStr);
                        }
                    } catch (e) {
                        console.error('Error parseando script:', e);
                    }
                }
            }
            return null;
        });
        if (state2) return state2;
    } catch (e) {
        console.log('Método 2 falló:', e.message);
    }

    // Método 3: Buscar en window object
    try {
        const state3 = await page.evaluate(() => {
            if (window.__PRELOADED_STATE__) {
                return window.__PRELOADED_STATE__;
            }
            // También buscar en otras propiedades globales
            if (window.__INITIAL_STATE__) {
                return window.__INITIAL_STATE__;
            }
            if (window.__STATE__) {
                return window.__STATE__;
            }
            return null;
        });
        if (state3) return state3;
    } catch (e) {
        console.log('Método 3 falló:', e.message);
    }

    // Método 4: Buscar scripts con tipo application/json
    try {
        const state4 = await page.evaluate(() => {
            const scripts = Array.from(document.querySelectorAll('script[type="application/json"]'));
            for (const script of scripts) {
                try {
                    const content = script.textContent;
                    if (content && (content.includes('"id"') || content.includes('"price"') || content.includes('pageState'))) {
                        return JSON.parse(content);
                    }
                } catch (e) {
                    console.error('Error parseando script JSON:', e);
                }
            }
            return null;
        });
        if (state4) return state4;
    } catch (e) {
        console.log('Método 4 falló:', e.message);
    }

    // Método 5: Buscar en data attributes
    try {
        const state5 = await page.evaluate(() => {
            const elements = document.querySelectorAll('[data-state], [data-preloaded], [data-initial-state]');
            for (const element of elements) {
                try {
                    const state = element.getAttribute('data-state') || 
                                 element.getAttribute('data-preloaded') || 
                                 element.getAttribute('data-initial-state');
                    if (state) {
                        return JSON.parse(state);
                    }
                } catch (e) {
                    console.error('Error parseando data attribute:', e);
                }
            }
            return null;
        });
        if (state5) return state5;
    } catch (e) {
        console.log('Método 5 falló:', e.message);
    }

    return null;
}

async function extractDataFromPage(page) {
    // Si no encontramos el JSON, extraemos datos directamente del DOM
    console.log('🔍 Extrayendo datos directamente del DOM...');
    
    const productData = await page.evaluate(() => {
        const getText = (selector) => {
            const element = document.querySelector(selector);
            return element ? element.textContent.trim() : null;
        };

        const getPrice = (selector) => {
            const priceElement = document.querySelector(selector);
            if (!priceElement) return null;
            
            const priceText = priceElement.textContent.replace(/[^\d.,]/g, '').replace(',', '');
            return parseFloat(priceText) || null;
        };

        const getAttribute = (selector, attr) => {
            const element = document.querySelector(selector);
            return element ? element.getAttribute(attr) : null;
        };

        // Intentar múltiples selectores comunes en Mercado Libre
        return {
            title: getText('h1.ui-pdp-title') || 
                   getText('.ui-pdp-title') || 
                   getText('h1') ||
                   document.title.replace(' - Mercado Libre', ''),
            
            price: getPrice('.andes-money-amount__fraction') || 
                   getPrice('.ui-pdp-price__part') ||
                   getPrice('.price-tag-fraction') ||
                   getPrice('[itemprop="price"]'),
            
            currency: getText('.andes-money-amount__currency-symbol') || 'MXN',
            
            description: getText('.ui-pdp-description__content') ||
                        getText('[itemprop="description"]') ||
                        getText('.item-description'),
            
            seller: getText('.ui-pdp-seller__header__title') ||
                   getText('.seller-info__name') ||
                   getText('[data-testid="seller-name"]'),
            
            condition: getText('.ui-pdp-subtitle') || 
                      getText('.item-condition') || 
                      'Nuevo',
            
            images: Array.from(document.querySelectorAll('.ui-pdp-gallery__figure img, .gallery-image, [data-js="gallery-image"]')).map(img => 
                img.src || img.getAttribute('data-src') || img.getAttribute('data-zoom')
            ).filter(src => src && !src.includes('data:image')),
            
            available: !!document.querySelector('.ui-pdp-buybox__quantity__available, .stock-available, [data-stock="available"]'),
            
            location: getText('.ui-pdp-seller__location') || 
                     getText('.item-location')
        };
    });

    return {
        pageState: {
            initialState: {
                id: 'manual-extraction',
                components: {
                    price: {
                        price: {
                            value: productData.price,
                            currency_id: productData.currency
                        }
                    }
                },
                share: {
                    title: productData.title
                }
            }
        },
        manualExtraction: true,
        productData: productData
    };
}

function extractProductInfo(preloadedState) {
    // return preloadedState;
    try {
        // Si es extracción manual
        if (preloadedState.manualExtraction) {
            return preloadedState.productData;
        }

        const initialState = preloadedState.pageState?.initialState;
        if (!initialState) {
            return preloadedState;
        }

        // Función mejorada para buscar item_status en múltiples ubicaciones
        const findItemStatus = (state) => {
            console.log('🔍 Buscando item_status en todas las rutas posibles...');
            
            // Rutas específicas basadas en el JSON proporcionado
            const paths = [
                // Rutas principales del track
                state?.data?.pageState?.initialState?.track?.melidata_event?.event_data?.item_status,
                state?.data?.pageState?.initialState?.track?.analytics_event?.custom_dimensions?.itemStatus,
                state?.data?.pageState?.initialState?.track?.gtm_event?.status,
                
                // Rutas dentro de components
                state?.data?.pageState?.initialState?.components?.highlighted_specs_attrs?.viewport_track?.melidata_event?.event_data?.item_status,
                state?.data?.pageState?.initialState?.components?.highlighted_specs_attrs?.components?.[0]?.action?.track?.melidata_event?.event_data?.item_status,
                state?.data?.pageState?.initialState?.components?.track?.analytics_event?.custom_dimensions?.customDimensions?.itemStatus,
                
                // Rutas directas en el estado inicial
                initialState?.track?.melidata_event?.event_data?.item_status,
                initialState?.track?.analytics_event?.custom_dimensions?.itemStatus,
                initialState?.track?.gtm_event?.status,
                
                // Rutas en pageState directo
                preloadedState?.pageState?.initialState?.track?.melidata_event?.event_data?.item_status,
                preloadedState?.pageState?.initialState?.track?.analytics_event?.custom_dimensions?.itemStatus
            ];
            
            console.log('Rutas verificadas:');
            for (let i = 0; i < paths.length; i++) {
                if (paths[i]) {
                    console.log(`✅ Ruta ${i}: ${paths[i]}`);
                    return paths[i];
                }
            }
            
            console.log('❌ No se encontró item_status en ninguna ruta');
            return 'unknown';
        };

        const components = initialState.components || {};

        console.log('🔍 Buscando item_status en:');
        console.log('- track path:', initialState.track?.melidata_event?.event_data?.item_status);
        console.log('- highlighted_specs path:', initialState.components?.highlighted_specs_attrs?.viewport_track?.melidata_event?.event_data?.item_status);
        
        // Extraer información estructurada
        const productInfo = {
            id: initialState.id || 'N/A',
            title: initialState.share?.title || 
                   components.header?.title || 
                   'No disponible',
            
            price: components.price?.price?.value || 
                   initialState.track?.melidata_event?.event_data?.price || 
                   0,

            item_status: findItemStatus(preloadedState),
            
            currency: components.price?.price?.currency_id || 
                     initialState.track?.melidata_event?.event_data?.currency_id || 
                     'MXN',
            
            condition: 'Nuevo', // Por defecto
            
            available_quantity: components.available_quantity?.quantity_selector?.available_quantity || 
                               (components.available_quantity?.picker?.description ? 
                                parseInt(components.available_quantity.picker.description.match(/\d+/)?.[0] || '0') : 0),
            
            sold_quantity: initialState.track?.melidata_event?.event_data?.sold_quantity || 0,
            
            permalink: initialState.schema?.[0]?.offers?.url || 
                      initialState.share?.permalink || 
                      '',
            
            seller: {
                id: initialState.track?.melidata_event?.event_data?.seller_id ||
                    components.seller_data?.viewport_track?.melidata_event?.event_data?.seller_id,
                
                name: components.seller_experiment?.title_value ||
                     components.seller_data?.components?.[0]?.title?.text?.replace('Vendido por ', ''),
                
                reputation: components.seller_data?.components?.[1]?.seller_status_info?.title?.text ||
                           components.seller_data?.components?.[1]?.thermometer_id
            },
            
            shipping: {
                free_shipping: components.shipping_summary?.title?.values?.promise?.text === 'Envío gratis' ||
                              initialState.track?.melidata_event?.event_data?.free_shipping === true,
                
                promise: components.shipping_summary?.title?.values?.promise?.text ||
                        'No disponible'
            },
            
            payment_methods: components.payment_methods?.payment_methods?.map(method => ({
                title: method.title?.text,
                subtitle: method.subtitle?.text,
                icons: method.icons?.map(icon => icon.name)
            })) || [],
            
            images: components.gallery?.pictures?.map(pic => ({
                id: pic.id,
                url: `https://http2.mlstatic.com/D_NQ_NP_${pic.id}-O${pic.sanitized_title}.webp`,
                alt: pic.alt
            })) || [],
            
            specifications: components.highlighted_specs_attrs?.components?.[1]?.specs || []
        };
        
        return productInfo;
    } catch (error) {
        console.log('Error extrayendo información del producto:', error);
        // Devolver el estado completo si hay error
        return preloadedState;
    }
}

async function handlePopups(page) {
    try {
        // Esperar un poco antes de buscar popups
        await wait(2000);
        
        const popupSelectors = [
            'button[data-testid="action:understood-button"]',
            'button[data-testid="login"]',
            '.andes-modal__close-button',
            '[aria-label="Cerrar"]',
            'button[aria-label="Cerrar"]',
            '.modal-close',
            '.dy-lb-close',
            '.onboarding-cp-close'
        ];
        
        for (const selector of popupSelectors) {
            try {
                const elements = await page.$$(selector);
                for (const element of elements) {
                    try {
                        await element.click();
                        console.log(`✅ Cerrado popup con selector: ${selector}`);
                        await wait(500);
                    } catch (clickError) {
                        // Ignorar errores de click
                    }
                }
            } catch (e) {
                // Ignorar errores de selectores no encontrados
            }
        }
    } catch (error) {
        console.log('No se pudieron cerrar popups:', error.message);
    }
}

// Manejo de errores no capturados
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Iniciar servidor
app.listen(PORT, () => {
    console.log(`🖥️ Servidor de scraping corriendo en puerto ${PORT}`);
    console.log(`📍 Health check: http://localhost:${PORT}/health`);
    console.log(`📍 Scraping endpoint: http://localhost:${PORT}/scrape`);
    console.log(`📍 Product info endpoint: http://localhost:${PORT}/scrape/product-info`);
});

module.exports = app;