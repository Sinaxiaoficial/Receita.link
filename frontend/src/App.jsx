import React, { useState, useEffect } from 'react';
import axios from 'axios';

import { Download, Copy, Loader2, Utensils, Clock, CheckCircle2, ChevronRight, Link2, FileText, Flame } from 'lucide-react';
import './index.css';

function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [recipe, setRecipe] = useState(() => {
    const saved = localStorage.getItem('receita_data');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return null;
      }
    }
    return null;
  });
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  // Limpeza única: remove a URL antiga que ficou salva no navegador do usuário
  useEffect(() => {
    localStorage.removeItem('receita_url');
  }, []);

  useEffect(() => {
    if (recipe) {
      localStorage.setItem('receita_data', JSON.stringify(recipe));
    } else {
      localStorage.removeItem('receita_data');
    }
  }, [recipe]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmedUrl = url.trim();

    if (!trimmedUrl) {
      setError('Por favor, cole um link do TikTok.');
      return;
    }

    // Validação customizada em PT-BR — evita a mensagem nativa do browser em inglês
    if (!/tiktok\.com/i.test(trimmedUrl)) {
      setError('Por favor, insira um link válido do TikTok (ex: https://www.tiktok.com/@user/video/...).');
      return;
    }

    setLoading(true);
    setError('');
    setRecipe(null);

    try {
      const apiUrl = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:3001');
      const response = await axios.post(`${apiUrl}/api/recipe/url`, { url }, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 290000, // 290s — margem de 10s antes do limite de 300s do Vercel Pro
      });
      setRecipe(response.data);
    } catch (err) {
      console.error(err);

      let errorMessage = 'Ocorreu um erro ao processar a receita. Tente novamente.';

      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        errorMessage = 'O vídeo é muito longo e o processamento excedeu o tempo limite. Tente com um vídeo mais curto (até 1 minuto) ou tente novamente.';
      } else if (err.response?.status === 504) {
        errorMessage = 'O servidor demorou demais para processar este vídeo. Tente novamente — a segunda tentativa costuma ser mais rápida.';
      } else if (err.response?.data?.error) {
        // Vercel retorna error como objeto {code, message} em alguns casos — garantir que é string
        const errData = err.response.data.error;
        errorMessage = typeof errData === 'string' ? errData : (errData?.message || errorMessage);
      }

      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (!recipe) return;
    
    let textToCopy = `Receita: ${recipe.titulo}\n\n`;
    if (recipe.rendimento) textToCopy += `Rendimento: ${recipe.rendimento}\n`;
    if (recipe.calorias_totais) textToCopy += `Calorias Totais: ${recipe.calorias_totais}\n\n`;
    
    textToCopy += 'Ingredientes:\n';
    recipe.ingredientes.forEach(secao => {
      textToCopy += `\n[${secao.secao}]\n`;
      secao.itens.forEach(item => {
         textToCopy += `- ${item.descricao} (${item.kcal})\n`;
      });
    });

    textToCopy += '\nModo de Preparo:\n';
    recipe.modo_preparo.forEach(secao => {
       textToCopy += `\n[${secao.secao}]\n`;
       secao.passos.forEach((passo, idx) => {
          textToCopy += `${idx + 1}. ${passo}\n`;
       });
    });

    if (recipe.creditos_autor) {
      textToCopy += `\n\n---\nReceita retirada do TikTok. Siga o criador original: ${recipe.creditos_autor}\n`;
    }

    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExportTXT = () => {
    if (!recipe) return;
    
    let textToCopy = `Receita: ${recipe.titulo}\n\n`;
    if (recipe.rendimento) textToCopy += `Rendimento: ${recipe.rendimento}\n`;
    if (recipe.calorias_totais) textToCopy += `Calorias Totais: ${recipe.calorias_totais}\n\n`;
    
    textToCopy += 'Ingredientes:\n';
    recipe.ingredientes.forEach(secao => {
      textToCopy += `\n[${secao.secao}]\n`;
      secao.itens.forEach(item => {
         textToCopy += `- ${item.descricao} (${item.kcal})\n`;
      });
    });

    textToCopy += '\nModo de Preparo:\n';
    recipe.modo_preparo.forEach(secao => {
       textToCopy += `\n[${secao.secao}]\n`;
       secao.passos.forEach((passo, idx) => {
          textToCopy += `${idx + 1}. ${passo}\n`;
       });
    });

    if (recipe.creditos_autor) {
      textToCopy += `\n\n---\nReceita retirada do TikTok. Siga o criador original: ${recipe.creditos_autor}\n`;
    }

    const element = document.createElement("a");
    const file = new Blob([textToCopy], {type: 'text/plain;charset=utf-8'});
    element.href = URL.createObjectURL(file);
    element.download = `${recipe?.titulo?.replace(/\s+/g, '_') || 'receita'}.txt`;
    document.body.appendChild(element); // Required for this to work in FireFox
    element.click();
    document.body.removeChild(element);
  };

  const handleExportPDF = async () => {
    const input = document.getElementById('recipe-content');
    if (!input) return;

    try {
      // Lazy-load: carrega apenas quando o usuário clica (economiza ~363KB no bundle inicial)
      const [{ default: html2canvas }, { default: jsPDF }] = await Promise.all([
        import('html2canvas'),
        import('jspdf'),
      ]);

      const canvas = await html2canvas(input, {
        scale: 2,
        backgroundColor: '#ffffff',
      });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`${recipe?.titulo?.replace(/\s+/g, '_') || 'receita'}.pdf`);
    } catch (err) {
      console.error("Erro ao gerar PDF", err);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-200">
      
      {/* Header */}
      <header className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md border-b border-slate-200 shadow-sm">
        <div className="max-w-5xl mx-auto px-6 py-0 flex items-center justify-between">
          <div className="flex items-center">
            <img src="/logo.png" alt="Receita.Link Logo" className="h-28 md:h-36 object-contain block" />
          </div>
        </div>
      </header>

      <main className="pt-36 md:pt-44 pb-12 px-4 flex flex-col items-center">
        
        {/* Input Section */}
        {!recipe && (
          <div className="w-full max-w-2xl mt-12 md:mt-20 animate-in fade-in slide-in-from-bottom-8 duration-700">
            <div className="text-center mb-10">
              <h1 className="text-4xl md:text-5xl font-extrabold mb-4 tracking-tight text-slate-900">
                Resgate Receitas do <span className="text-blue-600">TikTok</span>
              </h1>
              <p className="text-slate-600 text-lg md:text-xl">
                Cole o link de qualquer vídeo do TikTok e nossa inteligência artificial extrai os ingredientes e o modo de preparo para você em segundos.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="relative group max-w-xl mx-auto">
               <div className="relative bg-white border border-slate-200 p-2 pl-4 rounded-2xl flex items-center shadow-lg transition-all focus-within:ring-2 focus-within:ring-blue-500 focus-within:border-blue-500">
                 <Link2 className="w-6 h-6 text-slate-400 shrink-0" />
                 <input 
                   type="text" 
                   placeholder="Cole o link do TikTok aqui..."
                   value={url}
                   onChange={(e) => setUrl(e.target.value)}
                   className="w-full bg-transparent text-slate-900 placeholder-slate-400 outline-none px-4 py-3 text-lg"
                 />
                 <button 
                  type="submit"
                  disabled={loading || !url}
                  className="bg-blue-600 text-white px-6 py-3 rounded-xl font-medium hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 shadow-sm"
                 >
                   {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Extrair'}
                 </button>
               </div>
               
               {error && (
                 <p className="mt-4 text-rose-500 text-center animate-in fade-in font-medium">{error}</p>
               )}
            </form>

             {loading && (
              <div className="mt-16 text-center flex flex-col items-center gap-4 animate-in fade-in">
                <div className="w-16 h-16 relative">
                  <div className="absolute inset-0 rounded-full border-t-2 border-slate-200 animate-spin"></div>
                  <div className="absolute inset-0 rounded-full border-t-2 border-blue-600 animate-spin"></div>
                  <Utensils className="absolute inset-0 m-auto w-6 h-6 text-blue-600 animate-pulse" />
                </div>
                <p className="text-slate-600 font-medium tracking-wide animate-pulse">O Chef de IA está ouvindo o TikTok e anotando tudo...</p>
                <p className="text-sm text-slate-500 max-w-sm mx-auto animate-pulse">Vídeos curtos levam ~15s. Vídeos maiores (2-3 min) podem levar até 1 minuto. ⚡</p>
              </div>
            )}
          </div>
        )}

        {/* Recipe Result View */}
        {recipe && (
          <div className="w-full max-w-5xl animate-in fade-in slide-in-from-bottom-8 duration-700">
            
            {/* Action Bar */}
            <div className="sticky top-20 z-40 bg-white/90 backdrop-blur-xl border border-slate-200 py-3 px-4 rounded-2xl mb-8 flex flex-col sm:flex-row justify-between items-center gap-4 shadow-md">
               <button 
                onClick={() => {
                  setRecipe(null);
                  setUrl('');
                }}
                className="text-slate-500 hover:text-slate-900 transition-colors flex items-center gap-1 text-sm font-medium"
               >
                 <ChevronRight className="w-4 h-4 rotate-180" /> Nova Receita
               </button>
               <div className="flex gap-2 w-full sm:w-auto">
                 <button onClick={handleCopy} className="flex-1 flex justify-center items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 transition-colors text-sm font-semibold">
                   {copied ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
                   {copied ? 'Copiado' : 'Copiar Texto'}
                 </button>
                 <button onClick={handleExportTXT} className="flex-1 flex justify-center items-center gap-2 px-4 py-2.5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 transition-colors text-sm font-semibold">
                   <FileText className="w-4 h-4" />
                   Baixar TXT
                 </button>
                 <button onClick={handleExportPDF} className="flex-1 flex justify-center items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-600 text-white hover:bg-blue-700 transition-colors text-sm font-semibold shadow-sm">
                   <Download className="w-4 h-4" />
                   Salvar PDF
                 </button>
               </div>
            </div>

            {/* Main Content Area intended for PDF capture */}
            <div id="recipe-content" className="bg-white p-6 sm:p-10 md:p-12 rounded-3xl border border-slate-200 shadow-xl space-y-12">
              
              {/* Header */}
              <div className="text-center space-y-4">
                <h1 className="text-3xl md:text-5xl font-black tracking-tight text-slate-900 leading-tight">{recipe.titulo}</h1>
                <div className="flex flex-wrap items-center justify-center gap-3">
                  {recipe.rendimento && (
                    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-blue-50 border border-blue-100 text-blue-800 text-sm font-bold">
                      <Utensils className="w-4 h-4" />
                      <span>Rendimento: {recipe.rendimento}</span>
                    </div>
                  )}
                  {recipe.calorias_totais && (
                    <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-orange-50 border border-orange-100 text-orange-800 text-sm font-bold">
                      <Flame className="w-4 h-4" />
                      <span>Total: {recipe.calorias_totais}</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid md:grid-cols-12 gap-8 md:gap-16">
                
                {/* Ingredients Column */}
                <div className="md:col-span-5 space-y-8">
                  <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
                    <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
                      <Utensils className="w-5 h-5" />
                    </div>
                    <h2 className="text-2xl font-bold tracking-tight text-slate-900">Ingredientes</h2>
                  </div>

                  <div className="space-y-8">
                    {recipe.ingredientes?.map((secao, i) => (
                      <div key={i} className="space-y-4">
                        <h3 className="text-blue-600 font-bold uppercase tracking-widest text-xs">{secao.secao}</h3>
                        <ul className="space-y-3">
                          {secao.itens?.map((item, j) => (
                            <li key={j} className="flex items-start gap-3 justify-between w-full p-2 hover:bg-slate-50 rounded-xl transition-colors">
                              <div className="flex items-start gap-3">
                                <span className="mt-2 w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0"></span>
                                <span className="leading-relaxed font-medium text-slate-700">{item.descricao}</span>
                              </div>
                              {item.kcal && (
                                <span className="text-xs font-bold text-slate-500 bg-slate-100 border border-slate-200 px-2 py-1 rounded-lg shrink-0 w-max">{item.kcal}</span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Preparation Column */}
                <div className="md:col-span-7 space-y-8">
                  <div className="flex items-center gap-3 border-b border-slate-200 pb-4">
                    <div className="p-2 rounded-lg bg-slate-100 text-slate-900">
                      <Clock className="w-5 h-5" />
                    </div>
                    <h2 className="text-2xl font-bold tracking-tight text-slate-900">Modo de Preparo</h2>
                  </div>

                  <div className="space-y-10">
                    {recipe.modo_preparo?.map((secao, i) => (
                      <div key={i} className="space-y-6">
                         <h3 className="text-slate-500 font-bold uppercase tracking-widest text-xs">{secao.secao}</h3>
                         <div className="space-y-6">
                            {secao.passos?.map((passo, j) => (
                              <div key={j} className="flex items-start gap-4 p-5 rounded-2xl bg-slate-50 border border-slate-100 transition-colors">
                                <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center font-bold text-sm shrink-0 mt-0.5 text-white shadow-sm">
                                  {j + 1}
                                </div>
                                <p className="text-slate-700 leading-relaxed text-base md:text-lg font-medium">{passo}</p>
                              </div>
                            ))}
                         </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
              
              {recipe.creditos_autor && (
                <div className="mt-8 pt-8 flex flex-col items-center justify-center gap-2">
                  <div className="px-5 py-3 bg-slate-50 border border-slate-200 rounded-2xl text-center shadow-sm">
                    <p className="text-slate-600 font-medium text-sm md:text-base">
                      Receita retirada do TikTok. Siga o criador original:{' '}
                      <a href={`https://www.tiktok.com/${recipe.creditos_autor}`} target="_blank" rel="noopener noreferrer" className="text-blue-600 font-bold hover:underline">
                        {recipe.creditos_autor}
                      </a>
                    </p>
                  </div>
                </div>
              )}

            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
