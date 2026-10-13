import { setIcon } from "obsidian";
import { MouseEvent, useEffect, useRef } from "react";

interface IconProps {
	icon: string;
	className: string;
	tooltip?: string;
	onClick?: (event: MouseEvent<HTMLDivElement>) => void;
}

export const Icon = (props: IconProps) => {
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (ref.current) setIcon(ref.current, props.icon);
	}, [props.icon]);
	return (
		<div
			className={props.className}
			aria-label={props.tooltip}
			onClick={props.onClick}
			ref={ref}
		/>
	);
};
