import { setIcon } from "obsidian";
import { useEffect, useRef } from "react";

interface IconProps {
	icon: string;
	className: string;
	tooltip?: string;
}

export const Icon = (props: IconProps) => {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (ref.current) setIcon(ref.current, props.icon);
	}, [props.icon]);
	return (
		<div className={props.className} aria-label={props.tooltip} ref={ref} />
	);
};
