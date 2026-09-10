import type { JSX } from 'react/jsx-runtime'
import useScrollReveal from '../../hooks/useScrollReveal'

interface PipelineStep {
  num: string
  title: string
  desc: string
}

const pipelineSteps: PipelineStep[] = [
  { num: '01', title: 'Query intake',        desc: 'Customer message normalized, intent classified, language detected.' },
  { num: '02', title: 'Hybrid retrieval',    desc: 'Candidates pulled from vector store + BM25 keyword search in parallel.' },
  { num: '03', title: 'Rerank & fuse',       desc: 'Cross-encoder scores each chunk against the query. Top results survive.' },
  { num: '04', title: 'Grounded generation', desc: 'LLM answers with strict citation constraints. No source → no claim.' },
  { num: '05', title: 'Confidence gate',     desc: 'Below threshold? Escalate to human agent with full retrieval context.' },
]

interface UserStep {
  label: string
  title: string
  desc: string
}

const userSteps: UserStep[] = [
  {
    label: 'Step 01',
    title: 'Upload your knowledge',
    desc: 'Point Nexa at your help docs or upload PDFs. We parse, chunk, and embed everything automatically.',
  },
  {
    label: 'Step 02',
    title: 'Customize your widget',
    desc: "Set your bot's name, colors, and behavior. Define quick-start questions and escalation rules.",
  },
  {
    label: 'Step 03',
    title: 'Go live',
    desc: 'Drop a single script tag on your site. Your visitors get instant AI support — with human backup when needed.',
  },
]

export default function HowItWorks(): JSX.Element {
  const ref = useScrollReveal<HTMLElement>()

  return (
    <section id="how" ref={ref} className="py-16 sm:py-20 lg:py-25 px-5 sm:px-8 lg:px-15 scroll-mt-[68px]">
      <div className="max-w-[1100px] mx-auto">
        {/* Tag */}
        <div className="fu text-[10.5px] font-semibold tracking-[2.2px] uppercase text-teal mb-5 before:content-['/'] before:opacity-50">
          02 — How it works
        </div>

        {/* Heading */}
        <h2
          className="fu delay-100 font-serif font-bold leading-[1.08] tracking-[-0.5px] mb-4 text-white"
          style={{ fontSize: 'clamp(30px, 4.5vw, 52px)' }}
        >
          From zero to answering<br />
          tickets in minutes.
        </h2>

        <p className="fu delay-200 text-[15px] text-white/62 leading-[1.8] max-w-[520px] mb-13">
          Three steps to deploy — and a hybrid RAG pipeline doing the heavy lifting
          behind the scenes.
        </p>

        {/* 3-step cards */}
        <div className="fu delay-300 grid grid-cols-1 sm:grid-cols-3 gap-4 mb-12">
          {userSteps.map((s) => (
            <div
              key={s.label}
              className="bg-[#1a3543] border border-white/9 rounded-2xl p-7.5 backdrop-blur-2xl transition-colors hover:border-teal/30"
            >
              <div className="text-[10px] font-bold tracking-[2px] text-teal uppercase mb-3.5">
                {s.label}
              </div>
              <div className="font-serif text-[24px] font-bold text-white mb-3 leading-snug">
                {s.title}
              </div>
              <p className="text-[13.5px] text-white/60 leading-[1.75]">{s.desc}</p>
            </div>
          ))}
        </div>

        {/* Pipeline visualization */}
        <div className="fu delay-400 grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-10 lg:gap-14 items-start">
          {/* Left — description */}
          <div>
            <h3
              className="font-serif font-bold leading-[1.1] tracking-[-0.3px] mb-4 text-white"
              style={{ fontSize: 'clamp(24px, 3vw, 36px)' }}
            >
              Under the hood: the <em className="italic text-teal">RAG pipeline</em>
            </h3>
            <p className="text-[14.5px] text-white/62 leading-[1.82]">
              Every question goes through a hybrid retrieval pipeline — semantic
              vectors + keyword BM25, fused and reranked — so answers are grounded
              in <em>your</em> content, not the model's training data.
            </p>
          </div>

          {/* Right — Pipeline panel */}
          <div className="bg-[#1a3543] border border-white/9 rounded-2xl p-1.5 backdrop-blur-2xl">
            <div className="flex items-center gap-2 px-4 pt-3 pb-1.5 text-[10px] font-semibold tracking-[2px] text-white/30">
              <span className="w-1.5 h-1.5 rounded-full bg-teal" />
              PIPELINE
            </div>

            {pipelineSteps.map((s, i) => (
              <div
                key={s.num}
                className={`flex items-start gap-3 px-3 py-3 rounded-lg transition-colors hover:bg-teal/6 cursor-default ${i > 0 ? 'border-t border-white/5' : ''}`}
              >
                <div className="w-6 h-6 bg-teal/13 rounded-md flex items-center justify-center text-[9px] font-bold text-teal shrink-0 tracking-wide">
                  {s.num}
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-white mb-0.5">{s.title}</div>
                  <div className="text-[11.5px] text-white/55 leading-[1.5]">{s.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </section>
  )
}