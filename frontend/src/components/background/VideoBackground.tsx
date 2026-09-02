import type { JSX } from "react/jsx-runtime"

// TODO: this hardcoded remote asset URL should be moved to config if it needs to change by environment.
const VIDEO_URL =
  'https://res.cloudinary.com/dnc1cytc2/video/upload/v1781765865/Animate_this_image_into_an_ult_gwr_video_mvp_dhrk6l.mp4'

export default function VideoBackground(): JSX.Element {
  return (
    <div className="fixed inset-0 z-0 pointer-events-none">
      <video
        className="w-full h-full object-cover"
        autoPlay
        loop
        muted
        playsInline
        src={VIDEO_URL}
      />
      {/* Subtle dark tint so text stays readable without hiding the robot */}
      <div className="absolute inset-0 bg-[#08181f]/20" />
    </div>
  )
}
