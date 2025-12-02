const puppeteer = require('puppeteer');
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Al inicio del archivo, después de los imports
const MAX_CONCURRENT = process.env.MAX_CONCURRENT_SCRAPES || 5;
let activeScrapes = 0;

// Middleware de rate limiting
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: process.env.RATE_LIMIT_WINDOW || 60000,
  max: process.env.RATE_LIMIT_MAX_REQUESTS || 100,
  message: {
    success: false,
    error: 'Demasiadas solicitudes, por favor intente más tarde'
  }
});

app.use('/scrape/product-info', limiter);

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
    while (activeScrapes >= MAX_CONCURRENT) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    activeScrapes++;

    console.log('🚀 Iniciando scraping con extracción de JSON...');
    
    // Configuración optimizada para producción con Chromium del sistema
    const browserConfig = {
        headless: true,  // Usar el nuevo headless mode
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--single-process',
            '--disable-features=AudioServiceOutOfProcess',
            '--disable-features=IsolateOrigins',
            '--disable-site-isolation-trials',
            '--disable-web-security',
            '--disable-features=BlockInsecurePrivateNetworkRequests'
        ],
        // RUTA CRÍTICA: Usar Chromium del sistema
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 
                       '/usr/bin/chromium' || 
                       '/usr/bin/chromium-browser' || 
                       '/usr/bin/google-chrome-stable',
        // Configuraciones adicionales para estabilidad
    };
    
    console.log('🔧 Configuración de Puppeteer:', {
        executablePath: browserConfig.executablePath,
        headless: browserConfig.headless
    });
    
    let browser;
    try {
        browser = await puppeteer.launch(browserConfig);
        console.log('✅ Navegador iniciado correctamente');
        
        const page = await browser.newPage();
        
        // Configurar user agent real
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        
        // Configurar timeout
        page.setDefaultTimeout(60000);
        
        // Configurar viewport
        await page.setViewport({ width: 1280, height: 800 });
        
        // Interceptar requests para mejorar performance (opcional)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            // Bloquear recursos innecesarios para acelerar
            const resourceType = req.resourceType();
            if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font') {
                req.abort();
            } else {
                req.continue();
            }
        });
        
        console.log('📄 Navegando a la página:', url);
        
        await page.goto(url, { 
            waitUntil: 'networkidle0',
            timeout: 90000 
        });
        
        console.log('✅ Página cargada');
        
        // Esperar a que cargue completamente
        await page.waitForSelector('body', { timeout: 10000 });
        
        // Esperar un poco más para contenido dinámico
        await wait(2000);
        
        // Manejar popups si los hay
        await handlePopups(page);
        
        // Intentar múltiples formas de encontrar el JSON
        const preloadedState = await findPreloadedState(page);
        
        if (preloadedState) {
            console.log('✅ JSON __PRELOADED_STATE__ encontrado');
            return preloadedState;
        } else {
            console.log('⚠️ No se encontró JSON, extrayendo del DOM...');
            return await extractDataFromPage(page);
        }
        
    } catch (error) {
        console.error('❌ Error durante el scraping:', error);
        throw error;
    } finally {
        if (browser) {
            activeScrapes--;
            await browser.close();
            console.log('✅ Navegador cerrado');
        }
    }
}

async function findPreloadedState(page) {
    // Método 1: Buscar por ID
    try {
        await page.waitForSelector('#__PRELOADED_STATE__', { timeout: 3000 });
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
            if (window.__INITIAL_STATE__) {
                return window.__INITIAL_STATE__;
            }
            return null;
        });
        if (state3) return state3;
    } catch (e) {
        console.log('Método 3 falló:', e.message);
    }

    return null;
}

async function extractDataFromPage(page) {
    console.log('🔍 Extrayendo datos directamente del DOM...');
    
    const productData = await page.evaluate(() => {
        const getText = (selector) => {
            const element = document.querySelector(selector);
            return element ? element.textContent.trim() : null;
        };

        const getPrice = (selector) => {
            const priceElement = document.querySelector(selector);
            if (!priceElement) return null;
            
            const priceText = priceElement.textContent.replace(/[^\d.,]/g, '').replace(',', '.');
            return parseFloat(priceText) || null;
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
            
            images: Array.from(document.querySelectorAll('.ui-pdp-gallery__figure img, .gallery-image')).map(img => 
                img.src || img.getAttribute('data-src')
            ).filter(src => src && !src.includes('data:image')),
            
            available: !!document.querySelector('.ui-pdp-buybox__quantity__available'),
            
            location: getText('.ui-pdp-seller__location')
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
    try {
        // Si es extracción manual
        if (preloadedState.manualExtraction) {
            return preloadedState.productData;
        }

        const initialState = preloadedState.pageState?.initialState;
        if (!initialState) {
            return preloadedState;
        }

        const findItemStatus = (state) => {
            const paths = [
                state?.data?.pageState?.initialState?.track?.melidata_event?.event_data?.item_status,
                state?.data?.pageState?.initialState?.track?.analytics_event?.custom_dimensions?.itemStatus,
                initialState?.track?.melidata_event?.event_data?.item_status,
                preloadedState?.pageState?.initialState?.track?.melidata_event?.event_data?.item_status,
            ];
            
            for (const path of paths) {
                if (path) return path;
            }
            return 'unknown';
        };

        const components = initialState.components || {};

        const productInfo = {
            id: initialState.id || 'N/A',
            title: initialState.share?.title || 'No disponible',
            price: components.price?.price?.value || 0,
            item_status: findItemStatus(preloadedState),
            currency: components.price?.price?.currency_id || 'MXN',
            condition: 'Nuevo',
            available_quantity: components.available_quantity?.quantity_selector?.available_quantity || 0,
            sold_quantity: initialState.track?.melidata_event?.event_data?.sold_quantity || 0,
            permalink: initialState.share?.permalink || '',
            seller: {
                id: initialState.track?.melidata_event?.event_data?.seller_id,
                name: components.seller_experiment?.title_value || 'No disponible'
            },
            shipping: {
                free_shipping: components.shipping_summary?.title?.values?.promise?.text === 'Envío gratis',
                promise: components.shipping_summary?.title?.values?.promise?.text || 'No disponible'
            }
        };
        
        return productInfo;
    } catch (error) {
        console.log('Error extrayendo información del producto:', error);
        return preloadedState;
    }
}

async function handlePopups(page) {
    try {
        await wait(1000);
        
        const popupSelectors = [
            'button[data-testid="action:understood-button"]',
            '.andes-modal__close-button',
            '[aria-label="Cerrar"]',
            '.modal-close'
        ];
        
        for (const selector of popupSelectors) {
            try {
                const element = await page.$(selector);
                if (element) {
                    await element.click();
                    console.log(`✅ Cerrado popup: ${selector}`);
                    await wait(500);
                }
            } catch (e) {
                // Ignorar errores
            }
        }
    } catch (error) {
        console.log('No se pudieron cerrar popups:', error.message);
    }
}

// Manejo de errores
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
    
    // Verificar configuración de Puppeteer
    console.log('🔧 Configuración de Puppeteer:');
    console.log('- PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH || 'No definido');
});

module.exports = app;